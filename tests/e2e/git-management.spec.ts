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

test('real local backend: explicit stage, staged-only commit, confirmation cancel, history and dirty branch error', async ({ page }) => {
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
    await page.exposeFunction('gitManagementInvoke', async (method: string, args: unknown) => {
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
    await page.getByLabel('提交说明').fill('UI staged only');
    await page.getByRole('button', { name: '仅提交暂存区', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('不会跳过 hooks');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(command(['rev-parse', '--verify', 'HEAD'])).rejects.toBeDefined();
    await page.getByRole('button', { name: '仅提交暂存区', exact: true }).click();
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
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('DIRTY_WORKTREE');
    expect((await command(['branch', '--show-current'])).trim()).toBe('main');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
