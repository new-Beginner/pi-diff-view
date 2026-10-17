import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch, type ManagementArgs } from '../../src/git/local-management';
let code: string;
const exec = promisify(execFile);
test.beforeAll(async () => {
  const built = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {GitManagement} from './src/view/GitManagement';
    createRoot(document.getElementById('app')).render(<GitManagement transport={{invoke:(m,a)=>window.branchInvoke(m,a)}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' } });
  code = built.outputFiles[0].text;
});
for (const [operation, label, success] of [
  ['branchSwitch', '切换', '已切换到 feature'],
  ['branchRename', '重命名', '已将 feature 重命名为 renamed'],
  ['branchDelete', '安全删除', '已安全删除 feature'],
]) test(`${operation}: cancel, duplicate confirmation and refresh failure preserve the actual successful result`, async ({ page }) => {
  test.setTimeout(60000);
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR required');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'branch-ui-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key as keyof typeof env];
  const git = async (args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, windowsHide: true })).stdout.trim();
  const calls: ManagementArgs[] = [];
  let changed = false, failRefresh = true;
  try {
    await git(['init', '-b', 'main']); await git(['config', 'user.name', 'UI Branch']); await git(['config', 'user.email', 'ui@example.invalid']); await git(['config', 'commit.gpgsign', 'false']);
    await git(['commit', '--allow-empty', '-m', 'base']); await git(['branch', 'feature']);
    const head = await git(['rev-parse', 'HEAD']);
    await page.exposeFunction('branchInvoke', async (method: string, args: ManagementArgs) => {
      calls.push(args);
      if (changed && failRefresh && args.operation === 'branches') throw new Error('injected list refresh failure');
      try {
        const result = await dispatch(method, args, [root]);
        if (args.operation === operation) changed = true;
        return result;
      } catch (cause) { const e = cause as Error & {code?: string}; throw new Error(`${e.code}: ${e.message}`); }
    });
    await page.setContent('<div id="app"></div>'); await page.addScriptTag({ content: code });
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '分支', exact: true }).click();
    if (operation === 'branchRename') await page.getByLabel('重命名目标').fill('  renamed  ');
    const row = page.locator('.gm-branches li').filter({ hasText: 'feature' });
    await row.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(calls.filter(call => call.operation === operation)).toHaveLength(0);
    await row.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page.locator('.gm-notice')).toContainText(success);
    await expect(page.locator('.gm-notice')).toContainText('刷新失败');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.gm-branch')).toHaveText(operation === 'branchSwitch' ? 'feature' : 'main');
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', {name: label,exact:true})).toBeDisabled();
    const writes = calls.filter(call => call.operation === operation);
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ oid: head, expectedHead: head, expectedBranch: 'main' });
    if (operation === 'branchRename') expect(writes[0].newName).toBe('renamed');
    expect(await git(['branch', '--show-current'])).toBe(operation === 'branchSwitch' ? 'feature' : 'main');
    const names = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (operation === 'branchRename') expect(names.split('\n')).toEqual(['main', 'renamed']);
    if (operation === 'branchDelete') expect(names).toBe('main');
    failRefresh = false; await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (operation !== 'branchSwitch') await expect(page.locator('.gm-branches')).not.toContainText('feature');
    expect(calls.filter(call => call.operation === operation)).toHaveLength(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
for (const [operation, label, failure, message] of [
  ['branchSwitch', '切换', 'STALE_BRANCH: changed', '分支或 HEAD 已发生变化'],
  ['branchRename', '重命名', 'BRANCH_EXISTS: exists', '目标分支名已存在'],
  ['branchDelete', '安全删除', 'UNMERGED_BRANCH: unmerged', '分支尚未安全合并'],
  ['branchSwitch', '切换', 'GIT_TIMEOUT: Git timed out', '操作可能已执行'],
  ['branchRename', '重命名', 'Bridge request timed out', '操作可能已执行'],
  ['branchDelete', '安全删除', 'Background operation is still running', '操作可能已执行'],
]) test(`${operation}: ${failure} shows an actionable error and never retries the write`, async ({page}) => {
  const calls: string[] = [];
  await page.exposeFunction('branchInvoke', async (_method: string, args: ManagementArgs) => {
    calls.push(args.operation);
    const repository = {root:'fixture',head:'a'.repeat(40),branch:'main'};
    if (args.operation === 'status') return {...repository,entries:[]};
    if (args.operation === 'branches') return {repository,branches:[{name:'main',oid:repository.head,current:true},{name:'feature',oid:repository.head,current:false}]};
    throw new Error(failure);
  });
  await page.setContent('<div id="app"></div>'); await page.addScriptTag({content:code});
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'分支',exact:true}).click();
  if (operation === 'branchRename') await page.getByLabel('重命名目标').fill('renamed');
  await page.locator('.gm-branches li').filter({hasText:'feature'}).getByRole('button',{name:label,exact:true}).click();
  await page.getByRole('button',{name:'确认执行',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(message);
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
  await expect(page.locator('.gm-notice')).toHaveCount(0);
  expect(calls.filter(value=>value===operation)).toHaveLength(1);
  await page.getByText('查看 Git 原始信息',{exact:true}).click();
  await expect(page.getByRole('alert').locator('pre')).toContainText(failure);
});
