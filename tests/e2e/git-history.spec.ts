import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ManagementArgs } from '../../src/git/local-management';

let code: string, css: string;
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement';
    const view = createRoot(document.getElementById('app'));
    const transport = {invoke:(method,args)=>window.historyInvoke(args)};
    window.mount = root => view.render(<GitManagement transport={transport} root={root}/>);
    window.mount('D:/one');
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' } });
  code = bundle.outputFiles[0].text;
  css = await fs.readFile('src/view/theme.css', 'utf8') + (await fs.readFile('src/view/git-management.css', 'utf8')).replace("@import './theme.css';", '');
});
async function fixture(page: Page, base = 'light') {
  const calls: ManagementArgs[] = [], failures = new Set<string>(), releases: Array<() => void> = [];
  const state: { hold?: Partial<ManagementArgs> } = {};
  const key = (args: Partial<ManagementArgs>) => `${args.operation}:${args.ref ?? ''}:${args.path ?? ''}`;
  await page.exposeFunction('historyInvoke', async (args: ManagementArgs) => {
    calls.push(args); const fail = failures.has(key(args));
    if (state.hold && Object.entries(state.hold).every(([key, value]) => (args as any)[key] === value)) await new Promise<void>(resolve => releases.push(resolve));
    if (fail) throw Error('fixture read failed');
    if (args.operation === 'status') return { root: args.root, branch: 'main', head: a, entries: [{ path: 'local.txt', index: '?', working: '?', stats: { path: 'local.txt', additions: 1, deletions: 0 } }] };
    if (args.operation === 'history') return { repository: { root: args.root, branch: 'main', head: a }, commits: (args.skip ? [c] : [a, b]).map(oid => ({ oid, subject: oid === a ? 'Improve history navigation' : oid === b ? 'Initial implementation' : 'Empty commit', author: 'History Test', date: '2026-10-15T12:00:00Z' })), hasMore: !args.skip };
    if (args.operation === 'commitFiles') return { oid: args.ref, parent: args.ref === a ? b : null, entries: args.ref === c ? [] : [
      { path: 'src/shared.ts', status: 'M', additions: 2, deletions: 1 },
      { path: 'gone.txt', status: 'D', additions: 0, deletions: 3 },
      { path: 'binary.dat', status: 'A', additions: null, deletions: null, kind: 'binary' },
      { path: '.env.local', status: 'A', additions: 1, deletions: 0, blocked: 'Sensitive path' },
    ] };
    if (args.operation === 'commitDiff') return { text: `diff --git a/${args.path} b/${args.path}\n--- a/${args.path}\n+++ b/${args.path}\n@@ -1 +1 @@\n-before\n+${args.ref?.slice(0, 1)}:${args.path}:${args.root}\n`, truncated: args.path === 'gone.txt' };
    if (args.operation === 'diff') return { text: 'workspace patch', truncated: false };
    throw Error('Unexpected operation: ' + args.operation);
  });
  await page.setContent(`<html data-base="${base}"><body style="margin:0"><div id="app"></div></body></html>`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: code });
  await expect(page.getByRole('button', { name: 'local.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.gm-commit')).toHaveCount(2);
  return { calls, failures, state, key, release() { state.hold = undefined; for (const resolve of releases.splice(0)) resolve(); } };
}
const detail = (page: Page) => page.getByRole('region', { name: 'Git 详情' });
const file = (page: Page, name = 'src/shared.ts') => detail(page).getByRole('button', { name, exact: true });

for (const width of [360, 900]) for (const base of ['light', 'dark']) test(`history inline files share workspace patch rendering (${width} ${base})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 760 }); const f = await fixture(page, base);
  await page.locator('.gm-commit').first().focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.gm-commit').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(detail(page)).toContainText('4 个文件'); await expect(detail(page)).toContainText('第一父提交 bbbbbbbbbb');
  await expect(file(page, '.env.local')).toBeDisabled();
  await expect(detail(page).getByLabel('src/shared.ts 增删行数', { exact: true })).toHaveText('+2-1');
  await expect(detail(page).getByLabel('binary.dat 增删行数', { exact: true })).toHaveText('二进制');
  expect(f.calls.filter(args => args.operation === 'commitDiff')).toHaveLength(0);
  await file(page).click(); await expect(detail(page).locator('.gm-patch-add')).toContainText('+a:src/shared.ts:D:/one');
  await expect(detail(page).locator('.gm-patch-del')).toContainText('-before');
  expect(await page.locator('.gm-commit-detail').evaluate(node => node.parentElement?.querySelector(':scope > .gm-commit')?.getAttribute('aria-expanded'))).toBe('true');
  await page.mouse.move(0, 0);
  const count = f.calls.filter(args => args.operation === 'commitDiff').length;
  await file(page).click(); await file(page).click(); await expect(detail(page).locator('.gm-patch')).toBeVisible();
  expect(f.calls.filter(args => args.operation === 'commitDiff')).toHaveLength(count);
  await detail(page).getByRole('button', { name: '折叠全部文件', exact: true }).click();
  await expect(page.locator('.gm-inline-diff')).toHaveCount(0);
  await file(page, 'gone.txt').click(); await expect(detail(page)).toContainText('内容过长，仅显示前段');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.gm-scroll')!.scrollWidth <= document.querySelector('.gm-scroll')!.clientWidth)).toBe(true);
  expect(f.calls.every(args => ['status', 'history', 'commitFiles', 'commitDiff'].includes(args.operation))).toBe(true);
  await page.screenshot({ path: path.join(process.env.PI_SCRATCH_DIR!, `git-history-${width}-${base}.png`) });
  await page.locator('.gm-commit').first().click(); await expect(detail(page)).toHaveCount(0);
});

test('late file lists and patches never replace another commit or resurrect closed details', async ({ page }) => {
  const f = await fixture(page);
  f.state.hold = { operation: 'commitFiles', ref: a };
  await page.locator('.gm-commit').first().click(); await expect(detail(page)).toContainText('正在读取提交文件');
  await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeEnabled();
  await page.locator('.gm-commit').nth(1).click(); await expect(detail(page)).toContainText('首次提交，与空树比较');
  f.release(); await expect(detail(page)).toContainText(b);
  f.state.hold = { operation: 'commitDiff', ref: b };
  await file(page).click(); await expect.poll(() => f.calls.some(args => args.operation === 'commitDiff' && args.ref === b)).toBe(true);
  await page.locator('.gm-commit').first().click(); await expect(detail(page)).toContainText('第一父提交'); f.release();
  await file(page).click(); await expect(detail(page).locator('.gm-patch')).toContainText('+a:src/shared.ts');
  await expect(detail(page).locator('.gm-patch')).not.toContainText('+b:');
  f.state.hold = { operation: 'commitDiff', ref: a, path: 'gone.txt' };
  await file(page, 'gone.txt').click(); await expect.poll(() => f.calls.some(args => args.operation === 'commitDiff' && args.path === 'gone.txt')).toBe(true);
  await detail(page).getByRole('button', { name: '关闭详情', exact: true }).click(); f.release();
  await expect(detail(page)).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('metadata and patch errors retry explicitly without locking navigation', async ({ page }) => {
  const f = await fixture(page);
  const metadata = { operation: 'commitFiles', ref: a };
  f.failures.add(f.key(metadata)); await page.locator('.gm-commit').first().click();
  await expect(detail(page).getByRole('alert')).toContainText('fixture read failed');
  await expect(page.getByRole('button', { name: '工作区', exact: true })).toBeEnabled();
  expect(f.calls.filter(args => args.operation === 'commitFiles')).toHaveLength(1);
  f.failures.clear(); await detail(page).getByRole('button', { name: '重试', exact: true }).click(); await expect(file(page)).toBeVisible();
  const patch = { operation: 'commitDiff', ref: a, path: 'src/shared.ts' };
  f.failures.add(f.key(patch)); await file(page).click(); await expect(detail(page).getByRole('alert')).toContainText('fixture read failed');
  f.failures.clear(); await detail(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(detail(page).locator('.gm-patch')).toContainText('+a:src/shared.ts');
});

test('pagination, refresh, project and page switches discard the old selection', async ({ page }) => {
  const f = await fixture(page);
  await page.locator('.gm-commit').first().click(); await file(page).click(); await expect(detail(page).locator('.gm-patch')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.locator('.gm-commit')).toHaveCount(1);
  await expect(detail(page)).toHaveCount(0); await page.locator('.gm-commit').click(); await expect(detail(page)).toContainText('没有文件改动');
  await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(page.locator('.gm-commit')).toHaveCount(2);
  await page.locator('.gm-commit').first().click(); await expect(file(page)).toBeVisible();
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(detail(page)).toHaveCount(0);
  await page.locator('.gm-commit').first().click(); await expect(file(page)).toBeVisible();
  await page.evaluate(() => (window as any).mount('D:/two')); await expect(page.locator('.gm-root').first()).toContainText('D:/two'); await expect(detail(page)).toHaveCount(0);
  await page.locator('.gm-commit').first().click(); await file(page).click(); await expect(detail(page).locator('.gm-patch')).toContainText('D:/two');
  f.state.hold = { operation: 'commitDiff', path: 'gone.txt' }; await file(page, 'gone.txt').click();
  await expect.poll(() => f.calls.some(args => args.operation === 'commitDiff' && args.path === 'gone.txt')).toBe(true);
  await page.getByRole('button', { name: '工作区', exact: true }).click(); f.release();
  await expect(page.getByRole('button', { name: 'local.txt', exact: true })).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
});
