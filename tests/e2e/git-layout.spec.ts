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
    window.calls = []; window.failCommit = false; window.diffDelay = 0; window.failDiff = false; window.diffRevision = 1; window.failStats = false;
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
      if (args.operation === 'stats') {
        if (window.failStats) throw Error('stats unavailable');
        return {entries:args.paths.map((path, i) => i === 2 ? {path,additions:null,deletions:null,kind:'binary'} : {path,additions:args.scope === 'staged' ? 5 : 3,deletions:args.scope === 'staged' ? 1 : 2})};
      }
      if (args.operation === 'diff') {
        const revision = window.diffRevision;
        if (window.diffDelay) await new Promise(resolve => setTimeout(resolve, window.diffDelay));
        if (window.failDiff) throw Error('diff unavailable');
        return {text:'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1,1 +1,1 @@\\n-old\\n+new-' + revision + '-' + args.paths[0] + '\\n',truncated:false};
      }
      if (args.operation === 'branches') return {branches:[{name:'main',current:true,oid:'head'}]};
      if (args.operation === 'history') return {commits:[{oid:'abc123',subject:'created commit',author:'fixture',date:'2026-01-01'}],hasMore:false};
      if (args.operation === 'stashList') return {stashes:[]};
      if (args.operation === 'discardPreview') return {fingerprint:'snapshot',untracked:false};
      if (args.operation === 'stage' || args.operation === 'unstage') window.diffRevision++;
      if (args.operation === 'commit' && window.failCommit) throw Error('hook-blocked');
      return {ok:true,oid:args.operation === 'commit' ? 'abc123' : undefined};
    }};
  `;
});
async function open(page: Page, base = 'light') {
  await page.route('http://git-layout.invalid/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ status: assets[pathname] ? 200 : 404, contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html', body: assets[pathname] ?? '' });
  });
  await page.goto('http://git-layout.invalid/?base=' + base);
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.locator('.gm-file')).toHaveCount(80);
  await expect(page.locator('.gm-file-stats').first()).toHaveText('+3-2');
}
async function diffCalls(page: Page) { return page.evaluate(() => (window as any).calls.filter((c: any) => c.args.operation === 'diff').length); }
for (const width of [360, 600, 1100]) for (const base of ['light', 'dark']) {
  test(`Git fixed composer and unified selection ${width} ${base}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 640 }); await open(page, base);
    const composer = page.locator('.gm-composer'), scroll = page.locator('.gm-scroll');
    const summary = page.getByLabel('提交摘要'), submit = page.getByRole('button', { name: 'Commit', exact: true });
    await expect(composer).toBeVisible(); await expect(submit).toBeDisabled();
    await summary.fill('   '); await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
    await expect(submit).toBeDisabled();
    await summary.fill('layout summary'); await expect(submit).toBeEnabled();
    await page.locator('.gm-description summary').click();
    await page.getByLabel('提交描述').fill('Optional description');
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
    await expect(page.locator('.gm-inline-diff')).toContainText('+new-1');
    await expect(page.locator('.gm-patch-add')).toHaveCount(1);
    await first.click(); await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
    await first.click(); await expect(page.locator('.gm-inline-diff')).toBeVisible();
    await page.getByRole('button', { name: '折叠全部文件', exact: true }).click();
    await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
    const row = page.locator('.gm-file-row').first();
    expect(await row.getByRole('button', { name: /^暂存 / }).textContent()).toBe('');
    expect(await row.getByRole('button', { name: /^撤销 / }).textContent()).toBe('');
    for (const button of await page.locator('.gm-selection-actions button').all()) expect(await button.textContent()).toBe('');
    expect(await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).evaluate(e => Math.abs(e.getBoundingClientRect().left - document.querySelector('.gm-file-row input')!.getBoundingClientRect().left))).toBeLessThan(1);
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
    await expect(page.locator('.gm-file-stats').first()).toHaveText('+5-1');
    await expect(page.locator('.gm-discard')).toHaveCount(0);
    await expect(page.locator('.gm-file-row').first().getByRole('button', { name: /^取消暂存 / })).toBeVisible();
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await expect(page.locator('.gm-file')).toHaveCount(80);
    await expect(page.locator('.gm-file-stats').first()).toHaveText('+3-2');
    if (process.env.GIT_LAYOUT_SCREENSHOTS) {
      await fs.mkdir(path.join(process.env.PI_SCRATCH_DIR!, 'git-layout-1.4.5'), { recursive: true });
      await page.screenshot({path:path.join(process.env.PI_SCRATCH_DIR!, 'git-layout-1.4.5', `${width}-${base}.png`)});
    }
    expect(errors).toEqual([]);
  });
}

test('selected Commit requires summary, accepts optional description and retains both on errors', async ({ page }) => {
  await open(page);
  const submit = page.getByRole('button', { name: 'Commit', exact: true });
  await page.getByLabel('提交摘要').fill('  preserve summary  ');
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: '选择 src/very-long-directory/components/file-0.tsx', exact: true }).check();
  await page.locator('.gm-description summary').click();
  await page.getByLabel('提交描述').fill('  details\nsecond line  ');
  await page.evaluate(() => { (window as any).failCommit = true; });
  await submit.click();
  await expect(page.getByRole('dialog')).toContainText('创建 Commit 并写入历史');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('hook-blocked');
  await expect(page.getByLabel('提交摘要')).toHaveValue('  preserve summary  ');
  await expect(page.getByLabel('提交描述')).toHaveValue('  details\nsecond line  ');
  await page.getByRole('checkbox', { name: '选择 src/very-long-directory/components/file-0.tsx', exact: true }).check();
  await page.evaluate(() => { (window as any).failCommit = false; });
  await submit.click(); await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByLabel('提交摘要')).toHaveValue('');
  await expect(page.getByLabel('提交描述')).toHaveValue('');
  const commits = await page.evaluate(() => (window as any).calls.filter((c: any) => c.args.operation === 'commit'));
  expect(commits).toHaveLength(2);
  for (const commit of commits) expect(commit.args).toEqual({operation:'commit',scope:'workspace',paths:['src/very-long-directory/components/file-0.tsx'],summary:'preserve summary',description:'details\nsecond line',confirmed:true,root:'D:/project'});
  await page.getByRole('button', {name:'查看历史',exact:true}).click();
  await expect(page.locator('.gm-commit')).toContainText('created commit');
});

test('slow read never locks the Git page; cached reopen is immediate and refresh invalidates it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).diffDelay = 600; });
  const first = page.locator('.gm-file').first();
  await first.click();
  await expect(page.locator('.gm-inline-diff')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.git-management')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', {name:'暂存区',exact:true})).toBeEnabled();
  await expect(page.getByRole('checkbox', {name:'选择全部可操作文件',exact:true})).toBeEnabled();
  await expect(page.locator('.gm-file-row').first().getByRole('button', {name:/^暂存 /})).toBeEnabled();
  await expect(page.getByText('正在执行 Git，请勿重复操作…', {exact:true})).toHaveCount(0);
  await expect(page.getByText('正在读取差异…', {exact:true})).toBeVisible();
  await expect(page.locator('.gm-inline-diff')).toContainText('+new-1');
  const calls = await diffCalls(page);
  await first.click(); await first.click();
  await expect(page.locator('.gm-inline-diff')).toContainText('+new-1');
  expect(await diffCalls(page)).toBe(calls);
  await page.getByRole('button', {name:'刷新',exact:true}).click();
  await expect(page.getByRole('button', {name:'刷新',exact:true})).toBeEnabled();
  await page.evaluate(() => { (window as any).diffRevision = 2; (window as any).diffDelay = 0; });
  await first.click(); await expect(page.locator('.gm-inline-diff')).toContainText('+new-2');
  expect(await diffCalls(page)).toBe(calls + 1);
});

test('late diff cannot overwrite another file or resurrect after mutation; errors retry only explicitly', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).diffDelay = 350; });
  await page.locator('.gm-file').nth(0).click();
  await page.locator('.gm-file').nth(1).click();
  await expect(page.locator('.gm-inline-diff')).toContainText('file-1.tsx');
  await expect(page.locator('.gm-inline-diff')).not.toContainText('file-0.tsx');
  await page.locator('.gm-file').nth(3).click();
  await page.locator('.gm-file-row').nth(3).getByRole('button', {name:/^暂存 /}).click();
  await expect(page.getByRole('button', {name:'刷新',exact:true})).toBeEnabled();
  await page.waitForTimeout(400);
  await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
  await page.evaluate(() => { (window as any).diffDelay = 0; (window as any).failDiff = true; });
  await page.locator('.gm-file').nth(4).click();
  await expect(page.locator('.gm-inline-diff').getByRole('alert')).toContainText('diff unavailable');
  const failedCalls = await diffCalls(page); await page.waitForTimeout(250); expect(await diffCalls(page)).toBe(failedCalls);
  await page.evaluate(() => { (window as any).failDiff = false; });
  await page.locator('.gm-inline-diff').getByRole('button', {name:'重试',exact:true}).click();
  await expect(page.locator('.gm-inline-diff')).toContainText('file-4.tsx');
});

test('stats are scope-specific and binary/failed stats are never fabricated as zero', async ({ page }) => {
  await open(page);
  await expect(page.locator('.gm-file-stats').nth(2)).toHaveText('二进制');
  await expect(page.locator('.gm-file-stats').nth(2)).not.toContainText('+0');
  await page.getByRole('button', {name:'暂存区',exact:true}).click();
  await expect(page.locator('.gm-file-stats').first()).toHaveText('+5-1');
  await page.evaluate(() => { (window as any).failStats = true; });
  await page.getByRole('button', {name:'刷新',exact:true}).click();
  await expect(page.locator('.gm-file-stats').first()).toHaveText('行数未知');
  await expect(page.locator('.gm-file-stats').first()).not.toContainText('+0');
  await expect(page.getByRole('button', {name:'工作区',exact:true})).toBeEnabled();
});
