import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';

let assets: Record<string, string>;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['src/view/index.tsx'], bundle: true, write: false, outfile: 'index.js', platform: 'browser', format: 'esm', target: 'es2022', define: { 'process.env.NODE_ENV': '"test"' } });
  assets = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/index.css' : '/index.js', file.text]));
  assets['/mock.js'] = await fs.readFile('tests/e2e/mock.js', 'utf8') + `
    (() => { const original = window.pluginBridge.invoke.bind(window.pluginBridge); window.pluginBridge.invoke = async function(method, args, internal) {
      if (method !== 'diff.captureMaintenance') return original(method, args, internal);
      window.__demo.calls.push({ method, args, internal });
      if (args.action === 'inspect') return { root: args.root, count: 1, ids: ['legacy-lease'], fingerprint: 'a'.repeat(64) };
      if (window.__demo.maintenanceStale) throw new Error('Lease journal changed; inspect again');
      if (args.writersStopped !== true) throw new Error('Explicit confirmation required');
      return { ok: true, count: 1 };
    }; })();`;
  assets['/'] = (await fs.readFile('src/view/index.html', 'utf8')).replace('<body>', '<body><script src="/mock.js"></script>');
});
async function open(page: Page) {
  await page.route('https://maintenance-fixture.invalid/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ status: assets[pathname] ? 200 : 404, contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html', body: assets[pathname] ?? '' });
  });
  await page.goto('https://maintenance-fixture.invalid/?lang=zh-CN&scenario=panel&piViewOpen=' + encodeURIComponent('diff-session:session-a?sessionId=session-a'));
  await expect(page.locator('.dv-file').first()).toBeVisible();
  await page.locator('.dv-settings-menu > summary').click();
  await page.getByRole('button', { name: '采集维护/旧租约', exact: true }).click();
  await expect(page.locator('.dv-maintenance')).toContainText('legacy-lease');
  await page.getByRole('button', { name: '确认旧写入任务及后台进程已停止后清理', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认清理旧采集租约' })).toBeVisible();
}
async function retireCalls(page: Page) {
  return page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.captureMaintenance' && call.args.action === 'retire'));
}
test('requires explicit modal confirmation; cancel never sends a retirement and success refreshes review', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('后台进程均已停止');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await retireCalls(page)).toHaveLength(0);
  await page.locator('.dv-settings-menu > summary').click();
  await page.getByRole('button', { name: '确认旧写入任务及后台进程已停止后清理', exact: true }).click();
  const before = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').length);
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await retireCalls(page)).toHaveLength(1);
  expect((await retireCalls(page))[0].args.writersStopped).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').length)).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});
test('keeps the dialog open and reports a stale-journal rejection without claiming success', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).__demo.maintenanceStale = true; });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Lease journal changed');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.dv-toast')).toHaveCount(0);
});
