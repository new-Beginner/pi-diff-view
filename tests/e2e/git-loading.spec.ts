import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JobQueue } from '../../src/core/jobs';
import { ReadWriteQueue } from '../../src/core/read-write-queue';
import { LocalGitManagement } from '../../src/git/local-management';
import { git } from '../../src/git/runner';
let code: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement'; import {boundedTransport} from './src/view/transport';
    const transport = boundedTransport((method,args) => window.gitWire(method,args));
    createRoot(document.getElementById('app')).render(<GitManagement transport={transport}/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' } });
  code = bundle.outputFiles[0].text;
});
async function fixture(page: Page, many = false) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'git-loading-browser-'));
  const command = (args: string[]) => git(root, ['-c', 'user.name=Loading Test', '-c', 'user.email=loading@example.invalid', ...args]);
  await command(['init', '-b', 'main']); await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
  await command(['add', '--all']); await command(['commit', '-m', 'loading fixture']); await command(['branch', 'feature']);
  if (many) await Promise.all(Array.from({ length: 501 }, (_, i) => fs.writeFile(path.join(root, `untracked-${i}.txt`), 'untracked\n')));
  const state = { hold: '', failHistory: false }, releases: Array<() => void> = [], calls: string[] = [], admissions: number[] = [];
  const queue = new ReadWriteQueue(4), management = new LocalGitManagement(), tasks = new Set<Promise<unknown>>();
  const jobs = new JobQueue((method, args: any) => {
    const task = queue.run(async () => {
      calls.push(args.operation); const fail = args.operation === 'history' && state.failHistory;
      if (args.operation === state.hold) await new Promise<void>(resolve => releases.push(resolve));
      if (fail) throw new Error('obsolete history failure');
      return management.dispatch(method, args, [root]);
    }, args.operation === 'branchSwitch');
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
  });
  await page.exposeFunction('gitWire', async (method: string, args: any) => {
    admissions.push(Date.now());
    if (method === 'jobStart') {
      const started = jobs.start(args.method, args.args), result = await jobs.wait(started.jobId, args.waitMs);
      return result.state === 'pending' ? started : { ...started, ...result };
    }
    return jobs.poll(args.jobId);
  });
  return {
    root, state, calls, admissions,
    release() { state.hold = ''; for (const resolve of releases.splice(0)) resolve(); },
    async mount() { await page.setContent('<div id="app"></div>'); await page.addScriptTag({ content: code }); },
    async close() { this.release(); jobs.close(); await Promise.allSettled([...tasks]); await fs.rm(root, { recursive: true, force: true }); },
  };
}
test('real jobs and bounded bridge: failed large status does not block history or branches', async ({ page }) => {
  const f = await fixture(page, true);
  try {
    f.state.hold = 'status'; await f.mount();
    await expect(page.getByText('正在读取 Git 数据…', { exact: true })).toBeVisible();
    await expect(page.locator('.gm-branch')).toHaveText('正在读取…');
    await expect(page.getByRole('button', { name: '历史', exact: true })).toBeEnabled();
    f.release(); await expect(page.getByRole('alert')).toContainText('More than 500');
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await expect(page.locator('.gm-commit')).toContainText('loading fixture');
    await expect(page.locator('.gm-commit')).toBeEnabled(); await expect(page.locator('.gm-branch')).toHaveText('main');
    await page.getByRole('button', { name: '分支', exact: true }).click();
    await expect(page.locator('.gm-branches')).toContainText('feature');
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(f.calls.filter(op => op === 'status')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'history')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'branches')).toHaveLength(1);
    for (const at of f.admissions) expect(f.admissions.filter(t => t >= at && t < at + 1000).length).toBeLessThanOrEqual(6);
  } finally { await f.close(); }
});
test('real bridge: obsolete read errors stay isolated and slow writes still lock navigation', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.mount(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    f.state.hold = 'history'; f.state.failHistory = true;
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await expect.poll(() => f.calls.includes('history')).toBe(true);
    await expect(page.getByRole('button', { name: '分支', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '分支', exact: true }).click();
    await expect(page.locator('.gm-branches')).toContainText('feature');
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); f.release();
    f.state.hold = 'branchSwitch';
    await page.locator('.gm-branches li').filter({ hasText: 'feature' }).getByRole('button', { name: '切换', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect.poll(() => f.calls.includes('branchSwitch')).toBe(true);
    await expect(page.getByRole('button', { name: '历史', exact: true })).toBeDisabled();
    await expect(page.getByText('正在执行 Git，请勿重复操作…', { exact: true })).toBeVisible();
    f.release(); await expect(page.locator('.gm-branch')).toHaveText('feature');
    await expect(page.getByRole('button', { name: '历史', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(f.calls.filter(op => op === 'branchSwitch')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'status')).toHaveLength(1);
  } finally { await f.close(); }
});
test('real Git and bounded bridge: small untracked counts arrive with the file list', async ({ page }) => {
  const f = await fixture(page);
  try {
    await fs.writeFile(path.join(f.root, 'note.txt'), 'line\n'.repeat(10));
    await f.mount();
    await expect(page.locator('.gm-file-stats')).toHaveText('+10-0');
    await expect(page.getByRole('button', { name: 'note.txt', exact: true })).toBeEnabled();
    expect(f.calls.filter(op => op === 'status')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'stats')).toHaveLength(0);
    for (const at of f.admissions) expect(f.admissions.filter(t => t >= at && t < at + 1000).length).toBeLessThanOrEqual(6);
  } finally { await f.close(); }
});

test('real Git jobs: history opens a per-file patch through the bounded bridge', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.mount(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.locator('.gm-commit').click();
    const detail = page.getByRole('region', { name: 'Git 详情' });
    await expect(detail).toContainText('首次提交，与空树比较');
    await detail.getByRole('button', { name: 'base.txt', exact: true }).click();
    await expect(detail.locator('.gm-patch')).toContainText('+base');
    expect(f.calls.filter(op => op === 'status')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'commitFiles')).toHaveLength(1);
    expect(f.calls.filter(op => op === 'commitDiff')).toHaveLength(1);
    for (const at of f.admissions) expect(f.admissions.filter(t => t >= at && t < at + 1000).length).toBeLessThanOrEqual(6);
  } finally { await f.close(); }
});
