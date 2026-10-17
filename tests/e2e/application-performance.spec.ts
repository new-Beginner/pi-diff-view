import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
let code: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement';
    const transport = {invoke: (method, args) => window.performanceInvoke(args)};
    createRoot(document.getElementById('app')).render(<GitManagement transport={transport}/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' } });
  code = bundle.outputFiles[0].text;
});
for (const target of [
  { page: '分支', text: 'feature-fast' },
  { page: '历史', text: 'fast-history' },
]) test(`${target.page} loads with repository metadata without rereading full status`, async ({ page }) => {
  await page.setContent('<div id="app"></div>');
  await page.evaluate(() => {
    const realm = window as any;
    const status = { root: 'project', branch: 'main', head: 'a'.repeat(40), entries: [] };
    realm.statusCalls = 0;
    realm.performanceInvoke = async (args: any) => {
      if (args.operation === 'status') {
        if (++realm.statusCalls > 1) throw new Error('Unexpected full status on a list page');
        return status;
      }
      if (!args.includeRepository) throw new Error('List request must include repository metadata');
      if (args.operation === 'branches') return { repository: status, branches: [{ name: 'feature-fast', oid: 'b'.repeat(40), current: false }], truncated: false };
      if (args.operation === 'history') return { repository: status, commits: [{ oid: 'b'.repeat(40), subject: 'fast-history', author: 'test', date: 'today' }], hasMore: false };
      throw new Error('Unexpected operation');
    };
  });
  await page.addScriptTag({ content: code });
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: target.page, exact: true }).click();
  await expect(page.locator('.gm-list')).toContainText(target.text);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).statusCalls)).toBe(1);
});
test('typing and selection do not reparse an unchanged expanded patch', async ({ page }) => {
  await page.setContent('<div id="app"></div>');
  await page.evaluate(() => {
    const realm = window as any;
    const patch = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
    realm.patchSplits = 0;
    const split = String.prototype.split;
    String.prototype.split = function (this: string, ...args: any[]) {
      if (String(this) === patch) realm.patchSplits++;
      return (split as any).apply(this, args);
    } as any;
    realm.performanceInvoke = async (args: any) => args.operation === 'status'
      ? { root: 'project', branch: 'main', head: 'a'.repeat(40), entries: [{ path: 'a.txt', index: ' ', working: 'M' }] }
      : args.operation === 'stats' ? { entries: [{ path: 'a.txt', additions: 1, deletions: 1 }] }
      : args.operation === 'diff' ? { text: patch, truncated: false } : (() => { throw new Error('Unexpected operation'); })();
  });
  await page.addScriptTag({ content: code });
  await page.getByRole('button', { name: 'a.txt', exact: true }).click();
  await expect(page.locator('.gm-patch')).toContainText('+new');
  const before = await page.evaluate(() => (window as any).patchSplits);
  await page.getByRole('checkbox', { name: '选择 a.txt', exact: true }).check();
  await page.getByLabel('提交摘要').pressSequentially('responsive input');
  await page.getByLabel('提交摘要').fill('updated');
  expect(await page.evaluate(() => (window as any).patchSplits)).toBe(before);
  await expect(page.locator('.gm-patch-add')).toHaveText('+new\n');
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
});
test('failed list metadata refresh retains rows but fences stale actions until recovery', async ({ page }) => {
  await page.setContent('<div id="app"></div>');
  await page.evaluate(() => {
    const realm = window as any;
    const repository = { root: 'project', branch: 'main', head: 'a'.repeat(40), entries: [] };
    realm.failList = false;
    realm.performanceInvoke = async (args: any) => {
      if (args.operation === 'status') return repository;
      if (args.operation === 'branches') {
        if (realm.failList) throw new Error('Repository metadata unavailable');
        return { repository, branches: [{ name: 'feature-fast', oid: 'b'.repeat(40), current: false }], truncated: false };
      }
      throw new Error('Unexpected operation');
    };
  });
  await page.addScriptTag({ content: code });
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '分支', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).failList = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Repository metadata unavailable');
  await expect(page.locator('.gm-list')).toContainText('feature-fast');
  await expect(page.getByRole('button', { name: '切换', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '历史', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).failList = false; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换', exact: true })).toBeEnabled();
});
