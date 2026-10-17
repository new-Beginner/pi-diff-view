import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch, type ManagementArgs, type ManagementStatus } from '../../src/git/local-management';
import * as runner from '../../src/git/runner';
const exec = promisify(execFile);
let container: string, root: string;
async function command(args: string[]) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key as keyof typeof env];
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, windowsHide: true })).stdout.trim();
}
const call = (operation: string, args: Partial<ManagementArgs> = {}) => dispatch('gitManage', { operation, root, confirmed: true, ...args }, [root]) as Promise<any>;
const state = () => call('status') as Promise<ManagementStatus>;
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR required');
  container = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'branch-stability-'));
  root = path.join(container, 'repo'); await fs.mkdir(root);
  await command(['init', '-b', 'main']); await command(['config', 'user.name', 'Branch Test']); await command(['config', 'user.email', 'test@example.invalid']);
  await command(['config', 'commit.gpgsign', 'false']); await command(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n'); await command(['add', '.']); await command(['commit', '-m', 'base']); await command(['branch', 'feature']);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(container, { recursive: true, force: true }); });
it('returns actual repository state for switch, current rename and safe delete without altering dirty bytes', async () => {
  await fs.writeFile(path.join(root, 'base.txt'), 'staged\n'); await command(['add', '.']);
  await fs.writeFile(path.join(root, 'base.txt'), 'working\n'); await fs.writeFile(path.join(root, 'new.txt'), 'untracked\n');
  const before = await command(['status', '--porcelain=v1']), staged = await command(['diff', '--cached']);
  expect(await call('branchSwitch', { name: 'feature' })).toMatchObject({ ok: true, repository: { branch: 'feature' } });
  expect(await call('branchRename', { name: 'feature', newName: 'renamed/中文' })).toMatchObject({ ok: true, repository: { branch: 'renamed/中文' } });
  expect(await call('branchDelete', { name: 'main' })).toMatchObject({ ok: true, repository: { branch: 'renamed/中文' } });
  expect(await command(['status', '--porcelain=v1'])).toBe(before); expect(await command(['diff', '--cached'])).toBe(staged);
  expect(await fs.readFile(path.join(root, 'base.txt'), 'utf8')).toBe('working\n'); expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('untracked\n');
  expect(await command(['stash', 'list'])).toBe('');
}, 30000);
for (const operation of ['branchSwitch', 'branchRename', 'branchDelete']) {
  it(`${operation} rejects changed target or changed HEAD since confirmation`, async () => {
    const initial = await state();
    await command(['commit', '--allow-empty', '-m', 'advanced']);
    await expect(call(operation, { name: 'feature', newName: 'renamed', expectedHead: initial.head, expectedBranch: initial.branch })).rejects.toMatchObject({ code: 'STALE_BRANCH' });
    const current = await state();
    await command(['branch', '-f', 'feature', 'HEAD']);
    await expect(call(operation, { name: 'feature', newName: 'renamed', oid: initial.head!, expectedHead: current.head, expectedBranch: current.branch })).rejects.toMatchObject({ code: 'STALE_BRANCH' });
    expect((await state()).branch).toBe('main'); expect(await command(['rev-parse', 'feature'])).toBe(current.head);
  }, 30000);
  it(`${operation} refuses a branch occupied by another worktree`, async () => {
    await command(['worktree', 'add', path.join(container, 'other'), 'feature']);
    await expect(call(operation, { name: 'feature', newName: 'renamed' })).rejects.toMatchObject({ code: 'BRANCH_IN_USE' });
    expect(await command(['rev-parse', '--verify', 'feature'])).toBe((await state()).head);
  }, 30000);
}
it('refuses current/unmerged deletion and rename collisions; identical rename is a harmless no-op', async () => {
  await expect(call('branchDelete', { name: 'main' })).rejects.toMatchObject({ code: 'CURRENT_BRANCH' });
  await expect(call('branchRename', { name: 'feature', newName: 'main' })).rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
  expect(await call('branchRename', { name: 'feature', newName: 'feature' })).toMatchObject({ ok: true });
  await command(['switch', 'feature']); await command(['commit', '--allow-empty', '-m', 'unmerged']); await command(['switch', 'main']);
  await expect(call('branchDelete', { name: 'feature' })).rejects.toMatchObject({ code: 'UNMERGED_BRANCH' });
  expect(await command(['rev-parse', 'feature'])).not.toBe((await state()).head);
}, 30000);
it('never accepts a tag or deleted branch as the selected local branch', async () => {
  await command(['tag', 'only-tag']); await command(['branch', '-d', 'feature']);
  for (const name of ['feature', 'only-tag']) for (const operation of ['branchSwitch', 'branchRename', 'branchDelete']) {
    await expect(call(operation, { name, newName: 'renamed' })).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  }
}, 30000);
it('serializes duplicate deletion and reports the second request as missing, not success', async () => {
  const results = await Promise.allSettled([call('branchDelete', { name: 'feature' }), call('branchDelete', { name: 'feature' })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'BRANCH_NOT_FOUND' } });
}, 30000);
for (const operation of ['branchSwitch', 'branchRename', 'branchDelete']) {
  it(`${operation} remains successful when its post-mutation summary fails`, async () => {
    const original = runner.headCommit; let reads = 0;
    vi.spyOn(runner, 'headCommit').mockImplementation(async value => {
      if (++reads === (operation === 'branchDelete' ? 3 : 2)) throw new Error('injected post-mutation read failure');
      return original(value);
    });
    expect(await call(operation, { name: 'feature', newName: 'renamed' })).toMatchObject({ ok: true, notice: expect.stringContaining('操作已完成') });
    expect(await command(['branch', '--show-current'])).toBe(operation === 'branchSwitch' ? 'feature' : 'main');
    const names = (await command(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/'])).split('\n');
    expect(names.includes('feature')).toBe(operation === 'branchSwitch');
    if (operation === 'branchRename') expect(names).toContain('renamed');
  }, 30000);
  it(`${operation} reports a Git lock without deleting or overwriting anything`, async () => {
    const lock = path.join(root, '.git', operation === 'branchSwitch' ? 'index.lock' : `refs/heads/${operation === 'branchRename' ? 'renamed' : 'feature'}.lock`);
    await fs.writeFile(lock, 'external lock');
    await expect(call(operation, { name: 'feature', newName: 'renamed' })).rejects.toMatchObject({ code: 'GIT_LOCKED' });
    expect(await fs.readFile(lock, 'utf8')).toBe('external lock');
    expect(await command(['branch', '--show-current'])).toBe('main');
    expect(await command(['rev-parse', 'refs/heads/feature'])).toBe((await state()).head);
  }, 30000);
  it(`${operation} respects a merge already in progress`, async () => {
    await fs.writeFile(path.join(root, '.git/MERGE_HEAD'), await command(['rev-parse', 'HEAD']));
    await expect(call(operation, { name: 'feature', newName: 'renamed' })).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    expect(await command(['branch', '--show-current'])).toBe('main');
  }, 30000);
}
it('uses literal branch names when tags collide and supports detached HEAD', async () => {
  await command(['tag', 'main']); await command(['tag', 'feature']);
  expect((await state()).branch).toBe('main');
  await expect(call('branchDelete', { name: 'main' })).rejects.toMatchObject({ code: 'CURRENT_BRANCH' });
  await command(['switch', '--detach']);
  expect(await call('branchRename', { name: 'feature', newName: 'renamed' })).toMatchObject({ ok: true, repository: { branch: null } });
  expect(await call('branchSwitch', { name: 'renamed' })).toMatchObject({ ok: true, repository: { branch: 'renamed' } });
  expect(await command(['rev-parse', '--verify', 'refs/tags/feature'])).toBe((await state()).head);
}, 30000);
