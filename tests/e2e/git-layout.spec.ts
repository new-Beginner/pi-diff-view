import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

let assets: Record<string, string>;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['src/view/index.tsx'], bundle: true, write: false, outfile: 'index.js', platform: 'browser', format: 'esm', target: 'es2022' });
  assets = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/index.css' : '/index.js', file.text]));
  assets['/'] = (await fs.readFile('src/view/index.html', 'utf8')).replace('<body>', '<body><script src="/mock.js"></script>');
  assets['/mock.js'] = `
    const base = new URLSearchParams(location.search).get('base');
    const entries = Array.from({length: 80}, (_, i) => ({path: 'src/very-long-directory/components/file-' + i + '.tsx', index: 'M', working: 'M'}));
    window.calls = []; window.failCommit = false;
    window.pluginBridge = { on() {}, async invoke(method, args = {}) {
      window.calls.push({method, args});
      if (method === 'app.getAppearance') return {base, locale:'zh-CN'};
      if (method === 'diff.jobStart') {
        try { return {jobId:'fixture',state:'done',result:await window.pluginBridge.invoke('diff.' + args.method, args.args)}; }
        catch (error) { return {jobId:'fixture',state:'error',error:{code:'GIT_FAILED',message:error.message}}; }
      }
      if (method === 'diff.bootstrap') return {repositories:[{root:'D:/project',name:'project',git:true}],runs:[],settings:{}};
      if (method !== 'diff.gitManage') throw Error('Unexpected method ' + method);
      if (args.operation === 'status') return {root:'D:/project',branch:'main',head:'head',entries};
      if (args.operation === 'diff') return {text:'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1,1 +1,1 @@\\n-old\\n+new\\n',truncated:false};
      if (args.operation === 'branches') return {branches:[{name:'main',current:true,oid:'head'}]};
      if (args.operation === 'history') return {commits:[],hasMore:false};
      if (args.operation === 'stashList') return {stashes:[]};
      if (args.operation === 'discardPreview') return {fingerprint:'snapshot',untracked:false};
      if (args.operation === 'commit' && window.failCommit) throw Error('hook-blocked');
      return {ok:true};
    }};
  `;
});
async function open(page: Page, base: string) {
  await page.route('http://git-layout.invalid/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ status: assets[pathname] ? 200 : 404, contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html', body: assets[pathname] ?? '' });
  });
  await page.goto('http://git-layout.invalid/?base=' + base);
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.locator('.gm-file')).toHaveCount(80);
}
for (const width of [360, 600, 1100]) for (const base of ['light', 'dark']) {
  test(`Git fixed composer and inline files ${width} ${base}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 640 }); await open(page, base);
    const composer = page.locator('.gm-composer'), scroll = page.locator('.gm-scroll');
    const summary = page.getByLabel('提交说明'), submit = page.getByRole('button', { name: '仅提交暂存区', exact: true });
    await expect(composer).toBeVisible(); await expect(submit).toBeDisabled();
    await summary.fill('  \n '); await expect(submit).toBeDisabled();
    await summary.fill('layout summary'); await expect(submit).toBeEnabled();
    const before = await composer.boundingBox();
    expect(before!.y + before!.height).toBeLessThanOrEqual(641);
    expect(await scroll.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
    await scroll.evaluate(e => { e.scrollTop = e.scrollHeight; });
    expect(await composer.boundingBox()).toEqual(before);
    await expect(page.locator('.gm-file').last()).toBeInViewport();
    expect(await scroll.evaluate(e => e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(before!.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await scroll.evaluate(e => { e.scrollTop = 0; });
    const first = page.locator('.gm-file').first();
    await first.click(); await expect(first).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.gm-inline-diff')).toContainText('+new');
    await expect(page.locator('.gm-patch-add')).toHaveCount(1);
    await first.click(); await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
    await first.click(); await expect(page.locator('.gm-inline-diff')).toBeVisible();
    await page.getByRole('button', { name: '折叠全部文件', exact: true }).click();
    await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
    const row = page.locator('.gm-file-row').first();
    expect(await row.getByRole('button', { name: /^暂存 / }).textContent()).toBe('');
    expect(await row.getByRole('button', { name: /^撤销 / }).textContent()).toBe('');
    await row.getByRole('button', { name: /^暂存 / }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    const stage = await page.evaluate(() => (window as any).calls.find((c: any) => c.args.operation === 'stage'));
    expect(stage.args.paths).toEqual(['src/very-long-directory/components/file-0.tsx']);
    await row.getByRole('button', { name: /^撤销 / }).click();
    await expect(page.getByRole('dialog')).toContainText('不会更改暂存内容');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.args.operation === 'discard'))).toBe(false);
    for (const name of ['分支', '历史', 'Blame', 'Stash']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
      await expect(composer).toHaveCount(0);
    }
    await page.getByRole('button', { name: '暂存区', exact: true }).click();
    await expect(composer).toBeVisible(); await expect(summary).toHaveValue('layout summary');
    await expect(page.locator('.gm-discard')).toHaveCount(0);
    await expect(page.locator('.gm-file-row').first().getByRole('button', { name: /^取消暂存 / })).toBeVisible();
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await expect(page.locator('.gm-file')).toHaveCount(80);
    if (process.env.GIT_LAYOUT_SCREENSHOTS) {
      await fs.mkdir(path.join(process.env.PI_SCRATCH_DIR!, 'git-layout'), { recursive: true });
      await page.screenshot({path:path.join(process.env.PI_SCRATCH_DIR!, 'git-layout', `${width}-${base}.png`)});
    }
    expect(errors).toEqual([]);
  });
}

test('commit errors retain summary and confirmation sends trimmed staged-only message', async ({ page }) => {
  await open(page, 'light');
  await page.getByLabel('提交说明').fill('  preserve summary  ');
  await page.evaluate(() => { (window as any).failCommit = true; });
  await page.getByRole('button', { name: '仅提交暂存区', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('hook-blocked');
  await expect(page.getByLabel('提交说明')).toHaveValue('  preserve summary  ');
  await page.evaluate(() => { (window as any).failCommit = false; });
  await page.getByRole('button', { name: '仅提交暂存区', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByLabel('提交说明')).toHaveValue('');
  const commits = await page.evaluate(() => (window as any).calls.filter((c: any) => c.args.operation === 'commit'));
  expect(commits).toHaveLength(2);
  for (const commit of commits) expect(commit.args).toEqual({operation:'commit',message:'preserve summary',confirmed:true,root:'D:/project'});
});
