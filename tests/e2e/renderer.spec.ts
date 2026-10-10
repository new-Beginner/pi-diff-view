import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
let harness = '';
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/e2e/renderer-harness.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, loader: { '.css': 'empty' } })).outputFiles[0].text;
});
async function setup(page: Page, locale = 'en') {
  await page.route('**/renderer-demo*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><script src="/mock.js"></script><style>body{margin:0;font:14px/1.7 'Segoe UI',system-ui;background:#fff;color:#30343b}#mock-chat{padding:30px;width:min(880px,100%);box-sizing:border-box;transition:none}body.sidebar-open #mock-chat{width:calc(100% - 640px)}h1{font-size:17px;margin:0 0 26px}.demo-label{color:#7b8290;font-size:12px;padding:8px 16px;background:#f4f6f9}.mock-reply-text{padding:60px 0 12px}.mock-composer{margin-top:90px;border:1px solid #e4e7ec;border-radius:20px;padding:18px 20px;color:#8a929e}#demo-plugin-sidebar{position:fixed;right:0;top:0;bottom:0;width:640px;border-left:1px solid #e4e7ec;background:#fff;display:flex;flex-direction:column}#demo-plugin-sidebar header{padding:10px 14px;border-bottom:1px solid #e4e7ec;display:flex;justify-content:space-between}#demo-plugin-sidebar header button{background:transparent;border:0;cursor:pointer}#demo-plugin-sidebar iframe{width:100%;flex:1;border:0;min-height:0}</style></head><body><div class="demo-label">界面预览 · 测试数据与模拟宿主，不是实际会话验收</div><main id="mock-chat"><h1>Diff view 文末文件变更</h1><div class="mock-reply-text"><p>已完成本次修改，文件变更与检查结果如下。</p><p>点击下面的文件名，在右侧 Diff view 页签查看对应差异。</p></div><article id="mock-reply"></article><div class="mock-composer">与 PI 协作…</div></main></body></html>` }));
  await page.route('**/sidebar-demo*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/mock.js"></script><link rel="stylesheet" href="/index.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/index.js"></script></body></html>' }));
  await page.goto(`/renderer-demo?scenario=renderer&lang=${locale}`); await page.addScriptTag({ content: harness });
  await expect(page.locator('.dv-turn-card')).toHaveCount(1);
  await expect(page.locator('.dv-turn-file')).toHaveCount(3);
}
test('reply-end summary opens the plugin sidebar at the clicked file with no composer button or modal', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate(() => (window as any).__rendererDemo.positions)).toEqual([{ slot: 'entryExtra' }]);
  await expect(page.locator('.dv-composer, [data-test-slot="composerControl"], .dv-layer')).toHaveCount(0);
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe[title="Diff view plugin"]');
  await expect(frame.locator('.dv-file-heading h2')).toHaveText('src/theme/index.ts');
  await expect(frame.getByRole('combobox', { name: 'Scope' })).toHaveValue('turn');
  const opens = await page.evaluate(() => (window as any).__rendererDemo.opens);
  expect(opens).toHaveLength(1); expect(opens[0]).toMatchObject({ sessionId: 'session-demo', tab: { id: 'plugin:local.diff-view/review', resource: 'local.diff-view/review' } });
  expect(opens[0].tab.location).toMatch(/^diff-view:[0-9a-f-]{36}$/);
  expect(await page.evaluate(() => (window as any).__rendererDemo.draft)).toBe('Existing draft. ');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-turn-card, #demo-plugin-sidebar')).toHaveCount(0);
  expect(await page.evaluate(() => { const state = (window as any).__rendererDemo; return [state.styles, state.sidebars, state.subscriptions]; })).toEqual([0, 0, 0]);
  await page.waitForTimeout(400); const before = await page.evaluate(() => (window as any).__demo.calls.length);
  await page.waitForTimeout(6400); expect(await page.evaluate(() => (window as any).__demo.calls.length)).toBe(before);
});
test('file expansion is cached, external files are labelled, and collapse restores first three', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: /Show 1 more files/ }).click();
  await expect(page.locator('.dv-turn-file')).toHaveCount(4);
  await expect(page.locator('.dv-turn-file').last()).toContainText('Outside workspace · read-only');
  const before = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.turnSummary').length);
  await page.getByRole('button', { name: /Collapse files/ }).click(); await expect(page.locator('.dv-turn-file')).toHaveCount(3);
  await page.getByRole('button', { name: /Show 1 more files/ }).click(); await expect(page.locator('.dv-turn-file')).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.turnSummary').length)).toBe(before);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('an old-session click cannot open a sidebar in the new session', async ({ page }) => {
  await setup(page); await page.evaluate(() => (window as any).__rendererDemo.switchSession('other-session'));
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session changed');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(0);
  await expect(page.locator('.dv-layer, #demo-plugin-sidebar')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('chat summary and sidebar visual preview uses the implemented components', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await setup(page, 'zh-CN');
  await page.locator('.dv-turn-file').filter({ hasText: 'src/review/index.ts' }).click();
  await expect(page.frameLocator('iframe').locator('.dv-hunk')).toHaveCount(2);
  const destination = path.resolve('docs/screenshots/task-summary-sidebar.png'); await fs.mkdir(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('an existing plugin view receives a new selection through view:open without reloading', async ({ page }) => {
  await setup(page); await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-file-heading h2')).toHaveText('src/theme/index.ts');
  const nonce = await page.evaluate(async () => (await (window as any).pluginBridge.invoke('diff.selectTurn', { sessionId: 'session-demo', runId: 'run-demo', fileId: 'review' })).nonce);
  await frame.locator('body').evaluate((_element, value) => (window as any).__demo.openLocation(`diff-view:${value}`), nonce);
  await expect(frame.locator('.dv-file-heading h2')).toHaveText('src/review/index.ts');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
