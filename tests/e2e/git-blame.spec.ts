import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ManagementArgs } from '../../src/git/local-management';

let code: string, css: string;
const a = 'a'.repeat(40), b = 'b'.repeat(40);
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement';
    const view = createRoot(document.getElementById('app'));
    const transport = {invoke:(method,args)=>window.blameInvoke(args)};
    window.mount = root => view.render(<GitManagement transport={transport} root={root}/>);
    window.mount('D:/one');
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' } });
  code = bundle.outputFiles[0].text;
  css = await fs.readFile('src/view/theme.css', 'utf8') + (await fs.readFile('src/view/git-management.css', 'utf8')).replace("@import './theme.css';", '');
});
async function fixture(page: Page, base = 'light') {
  const calls: ManagementArgs[] = [], releases: Array<() => void> = [];
  const state = { hold: false, fail: false, empty: false };
  await page.exposeFunction('blameInvoke', async (args: ManagementArgs) => {
    calls.push(args);
    if (args.operation === 'status') return { root: args.root, branch: 'main', head: a, entries: [] };
    if (args.operation !== 'blame') throw Error('Unexpected operation: ' + args.operation);
    if (state.hold) await new Promise<void>(resolve => releases.push(resolve));
    if (state.fail) throw Error('追溯读取失败');
    const next = !!args.skip;
    return { oid: a, path: args.path, totalLines: state.empty ? 0 : 103, skip: args.skip, hasMore: !next && !state.empty,
      commits: state.empty ? [] : [{ oid: a, subject: '改善代码可读性与布局', author: '张三', date: '2026-10-16T12:00:00Z' }, ...(!next ? [{ oid: b, subject: '初始化实现', author: '李四', date: '2026-10-15T12:00:00Z' }] : [])],
      lines: state.empty ? [] : Array.from({ length: next ? 3 : 100 }, (_, index) => ({ oid: next || index % 2 === 0 ? a : b, line: (args.skip ?? 0) + index + 1, originalLine: index + 1, text: index === 0 ? '<script>literal</script> ' + 'very-long-code'.repeat(60) : `const line${index} = '${args.root}';`, truncated: index === 0 })) };
  });
  await page.setContent(`<html data-base="${base}"><body style="margin:0"><div id="app"></div></body></html>`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: code });
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Stash|Blame/ })).toHaveCount(0);
  await page.getByRole('button', { name: '追溯', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.getByLabel('仓库相对文件路径').fill('src/example.ts');
  return { calls, state, release() { state.hold = false; for (const resolve of releases.splice(0)) resolve(); } };
}
const start = (page: Page) => page.getByRole('button', { name: '开始追溯', exact: true });
for (const width of [360, 900]) for (const base of ['light', 'dark']) test(`history-style attribution groups and readable inline code (${width} ${base})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 760 }); const f = await fixture(page, base);
  await page.getByLabel('仓库相对文件路径').press('Enter');
  await expect(page.locator('.gm-commit')).toHaveCount(2);
  await expect(page.locator('.gm-commit').first()).toContainText('改善代码可读性'); await expect(page.locator('.gm-commit').first()).toContainText('50 行');
  await expect(page.getByRole('region', { name: '追溯代码行' })).toHaveCount(0);
  await page.locator('.gm-commit').first().focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.gm-blame-number').first()).toHaveText('1'); await expect(page.locator('.gm-blame-number').nth(1)).toHaveText('3');
  await expect(page.locator('.gm-blame-gap')).toHaveCount(49); await expect(page.locator('.gm-blame-code')).toContainText('<script>literal</script>');
  await expect(page.locator('.gm-blame-code')).toContainText('此行过长');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.gm-scroll')!.scrollWidth <= document.querySelector('.gm-scroll')!.clientWidth)).toBe(true);
  await page.screenshot({ path: path.join(process.env.PI_SCRATCH_DIR!, `git-blame-${width}-${base}.png`) });
  await page.getByRole('button', { name: '收起代码', exact: true }).click();
  await page.getByLabel('仓库相对文件路径').fill('another-file.ts');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.gm-blame-summary')).toContainText('example.ts'); await expect(page.locator('.gm-commit')).toHaveCount(1);
  expect(f.calls.at(-1)).toMatchObject({ operation: 'blame', skip: 100, ref: a, path: 'src/example.ts' });
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(page.locator('.gm-commit')).toHaveCount(2);
  expect(f.calls.at(-1)?.skip).toBe(0);
});

test('empty/error recovery and late responses cannot revive a switched page or project', async ({ page }) => {
  const f = await fixture(page);
  f.state.fail = true; await start(page).click(); await expect(page.getByRole('alert')).toContainText('追溯读取失败');
  f.state.fail = false; f.state.empty = true; await start(page).click(); await expect(page.locator('.gm-blame')).toContainText('文件为空');
  f.state.empty = false; f.state.hold = true; await start(page).click(); await expect(page.getByRole('status')).toContainText('正在读取追溯');
  await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '工作区', exact: true }).click(); f.release(); await expect(page.locator('.gm-blame')).toHaveCount(0);
  await page.getByRole('button', { name: '追溯', exact: true }).click(); await page.getByLabel('仓库相对文件路径').fill('old.ts');
  f.state.hold = true; await start(page).click(); await page.evaluate(() => (window as any).mount('D:/two')); f.release();
  await expect(page.locator('.gm-root').first()).toContainText('D:/two'); await expect(page.locator('.gm-commit')).toHaveCount(0);
  await page.getByLabel('仓库相对文件路径').fill('new.ts'); await start(page).click(); await expect(page.locator('.gm-commit')).toHaveCount(2);
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.locator('.gm-commit')).toHaveCount(0);
  expect(f.calls.every(args => ['status', 'blame'].includes(args.operation))).toBe(true);
});
