import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { dispatch } from '../../src/git/local-management';

// Compile only the isolated browser fixture in memory. No project build or generated workspace files.
let browserCode: string;
const exec = promisify(execFile);
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement';
    const transport = {invoke: (method, args) => window.gitManagementInvoke(method, args)};
    createRoot(document.getElementById('app')).render(<GitManagement transport={transport}/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' } });
  browserCode = bundle.outputFiles[0].text;
});

test('real local backend: stage, staged-only commit, history, safe dirty switch and overwrite refusal', async ({ page }) => {
  test.setTimeout(60000);
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated Git tests.');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'git-management-ui-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_CONFIG_NOSYSTEM = '1';
  const command = async (args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, windowsHide: true })).stdout;
  try {
    await command(['init', '-b', 'main']);
    await command(['config', 'user.name', 'UI Test']); await command(['config', 'user.email', 'ui@example.invalid']);
    await command(['config', 'commit.gpgsign', 'false']); await command(['config', 'core.hooksPath', '/dev/null']);
    await fs.writeFile(path.join(root, 'a.txt'), 'selected\n'); await fs.writeFile(path.join(root, 'keep.txt'), 'keep untracked\n');
    const operations: string[] = [];
    await page.exposeFunction('gitManagementInvoke', async (method: string, args: unknown) => {
      operations.push((args as { operation: string }).operation);
      try { return await dispatch(method, args, [root]); }
      catch (cause) { const error = cause as Error & { code?: string }; throw new Error(`${error.code}: ${error.message}`); }
    });
    await page.setContent('<html><body><div id="app"></div></body></html>');
    await page.addStyleTag({ content: await fs.readFile('src/view/theme.css', 'utf8') });
    await page.addStyleTag({ content: (await fs.readFile('src/view/git-management.css', 'utf8')).replace("@import './theme.css';", '') });
    await page.addScriptTag({ content: browserCode });
    await expect(page.getByRole('button', { name: 'a.txt', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '选择 a.txt', exact: true }).check();
    await page.getByRole('button', { name: '暂存所选 (1)', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '暂存区', exact: true }).click();
    await expect(page.getByRole('button', { name: 'a.txt', exact: true })).toBeVisible();
    await fs.writeFile(path.join(root, 'a.txt'), 'unstaged later\n');
    await page.getByRole('checkbox', { name: '选择 a.txt', exact: true }).check();
    await page.getByLabel('提交摘要').fill('UI staged only');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('不会跳过 hooks');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(command(['rev-parse', '--verify', 'HEAD'])).rejects.toBeDefined();
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    expect(await command(['show', 'HEAD:a.txt'])).toBe('selected\n');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('unstaged later\n');
    expect(await command(['ls-tree', '--name-only', 'HEAD'])).not.toContain('keep.txt');
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByRole('button', { name: /UI staged only/ }).click();
    await expect(page.getByRole('region', { name: 'Git 详情' })).toContainText('+selected');
    await page.getByRole('button', { name: '分支', exact: true }).click();
    await page.getByLabel('新分支名').fill('feature');
    await page.getByRole('button', { name: '从 HEAD 创建', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await page.locator('li').filter({ hasText: 'feature' }).getByRole('button', { name: '切换', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('不会强制覆盖');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(operations.filter(operation => operation === 'branchSwitch')).toHaveLength(0);
    await page.locator('li').filter({ hasText: 'feature' }).getByRole('button', { name: '切换', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.locator('.gm-branch')).toHaveText('feature');
    expect((await command(['branch', '--show-current'])).trim()).toBe('feature');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('unstaged later\n');
    expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('keep untracked\n');
    await fs.writeFile(path.join(root, 'a.txt'), 'feature committed\n');
    await command(['add', '--', 'a.txt']); await command(['commit', '-m', 'feature change']);
    await command(['switch', 'main']); await fs.writeFile(path.join(root, 'a.txt'), 'unstaged later\n');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.locator('.gm-branch')).toHaveText('main');
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    const beforeHead = await command(['rev-parse', 'HEAD']), beforeIndex = await fs.readFile(path.join(root, '.git/index'));
    await page.locator('li').filter({ hasText: 'feature' }).getByRole('button', { name: '切换', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('切换会覆盖本地改动');
    await expect(page.getByRole('button', { name: '查看工作区', exact: true })).toBeEnabled();
    await page.getByText('查看 Git 原始信息', { exact: true }).click();
    await expect(page.getByRole('alert').locator('pre')).toContainText('would be overwritten');
    expect((await command(['branch', '--show-current'])).trim()).toBe('main');
    expect(await command(['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(beforeIndex);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('unstaged later\n');
    await page.getByRole('button', { name: '前往 Stash', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建 Stash', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创建 Stash', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('保存仓库改动');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(operations.filter(operation => operation === 'branchSwitch')).toHaveLength(2);
    expect(operations.some(operation => ['stashCreate', 'stashApply', 'stashPop'].includes(operation))).toBe(false);
    expect(await command(['stash', 'list'])).toBe('');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real selected workspace Commit creates history directly and preserves unselected staged/working files', async ({ page }) => {
  test.setTimeout(60000);
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required.');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'git-direct-ui-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_CONFIG_NOSYSTEM = '1';
  const command = async (args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, windowsHide: true })).stdout;
  try {
    await command(['init', '-b', 'main']);
    await command(['config', 'user.name', 'UI Test']); await command(['config', 'user.email', 'ui@example.invalid']);
    await command(['config', 'commit.gpgsign', 'false']); await command(['config', 'core.hooksPath', '/dev/null']);
    for (const name of ['a.txt', 'keep-staged.txt', 'keep-working.txt']) await fs.writeFile(path.join(root, name), 'base\n');
    await command(['add', '--', 'a.txt', 'keep-staged.txt', 'keep-working.txt']); await command(['commit', '-m', 'initial']);
    await fs.writeFile(path.join(root, 'a.txt'), 'direct\nsecond line\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
    await fs.writeFile(path.join(root, 'keep-staged.txt'), 'staged keep\n'); await command(['add', '--', 'keep-staged.txt']);
    await fs.writeFile(path.join(root, 'keep-staged.txt'), 'working keep\n'); await fs.writeFile(path.join(root, 'keep-working.txt'), 'unselected\n');
    await page.exposeFunction('gitManagementInvoke', async (method: string, args: unknown) => {
      try { return await dispatch(method, args, [root]); }
      catch (cause) { const error = cause as Error & { code?: string }; throw new Error(`${error.code}: ${error.message}`); }
    });
    await page.setContent('<html><body><div id="app"></div></body></html>');
    await page.addStyleTag({ content: await fs.readFile('src/view/theme.css', 'utf8') });
    await page.addStyleTag({ content: (await fs.readFile('src/view/git-management.css', 'utf8')).replace("@import './theme.css';", '') });
    await page.addScriptTag({ content: browserCode });
    await expect(page.locator('.gm-file-stats').first()).toHaveText('+2-1');
    await page.getByRole('checkbox', {name:'选择 a.txt',exact:true}).check();
    await page.getByRole('checkbox', {name:'选择 new.txt',exact:true}).check();
    await page.getByLabel('提交摘要').fill('Direct selected');
    await page.locator('.gm-description summary').click(); await page.getByLabel('提交描述').fill('Details\nSecond paragraph line');
    await page.getByRole('button', {name:'Commit',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('2 个勾选文件');
    await page.getByRole('button', {name:'确认执行',exact:true}).click();
    await expect(page.getByText(/Commit 已创建/)).toBeVisible();
    await expect(page.getByRole('button', {name:'刷新',exact:true})).toBeEnabled();
    expect(await command(['show', 'HEAD:a.txt'])).toBe('direct\nsecond line\n');
    expect(await command(['show', 'HEAD:new.txt'])).toBe('new\n');
    expect(await command(['show', 'HEAD:keep-staged.txt'])).toBe('base\n');
    expect(await command(['show', ':keep-staged.txt'])).toBe('staged keep\n');
    expect(await fs.readFile(path.join(root, 'keep-staged.txt'), 'utf8')).toBe('working keep\n');
    expect(await fs.readFile(path.join(root, 'keep-working.txt'), 'utf8')).toBe('unselected\n');
    expect(await command(['log', '-1', '--format=%B'])).toContain('Direct selected\n\nDetails\nSecond paragraph line');
    await page.getByRole('button', {name:'查看历史',exact:true}).click();
    await expect(page.locator('.gm-commit').first()).toContainText('Direct selected');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
