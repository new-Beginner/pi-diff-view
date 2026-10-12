import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch, type ManagementArgs, type ManagementStatus, type ManagementText, type ManagementStash } from '../../src/git/local-management';

const exec = promisify(execFile);
let container: string, root: string;
async function command(args: string[], cwd = root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_CONFIG_NOSYSTEM = '1';
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, timeout: 15000, windowsHide: true })).stdout;
}
const call = <T = unknown>(operation: string, args: Partial<ManagementArgs> = {}) => dispatch('gitManage', { operation, root, ...args }, [root]) as Promise<T>;
async function write(rel: string, value: string) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), value); }
async function fixture() { await write('a.txt', 'base\n'); await command(['add', '--', 'a.txt']); await command(['commit', '-m', 'initial']); }
async function stashList() { return (await call<{ stashes: ManagementStash[] }>('stashList')).stashes; }
const confirm = { confirmed: true };
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required: tests may only create repositories in session scratch.');
  container = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'local-management-'));
  root = path.join(container, 'repo'); await fs.mkdir(root);
  await command(['init', '-b', 'main']);
  await command(['config', 'user.name', 'Local Management Test']); await command(['config', 'user.email', 'test@example.invalid']);
  await command(['config', 'commit.gpgsign', 'false']); await command(['config', 'core.autocrlf', 'false']);
  // Override any user's global hook directory with this isolated fixture's hooks.
  await command(['config', 'core.hooksPath', path.join(root, '.git/hooks').replace(/\\/g, '/')]);
});
afterEach(async () => { if (container) await fs.rm(container, { recursive: true, force: true }); });

describe('independent authorized local Git management', () => {
  it('rejects unauthorized/enclosing/no repositories and unsupported remote operations', async () => {
    await fs.mkdir(path.join(root, 'sub'));
    await expect(dispatch('gitManage', { operation: 'status', root }, [path.join(root, 'sub')])).rejects.toMatchObject({ code: 'ROOT_DENIED' });
    await expect(dispatch('gitManage', { operation: 'status' }, [path.join(root, 'sub')])).rejects.toMatchObject({ code: 'NO_REPOSITORY' });
    await expect(dispatch('gitManage', { operation: 'status', root: container }, [container])).rejects.toMatchObject({ code: 'NO_REPOSITORY' });
    for (const operation of ['fetch', 'pull', 'push', 'merge', 'rebase']) await expect(call(operation)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(dispatch('wrong', {}, [root])).rejects.toMatchObject({ code: 'INVALID_METHOD' });
    expect(await call('history')).toMatchObject({ commits: [], hasMore: false });
    await expect(call('stashCreate', confirm)).rejects.toMatchObject({ code: 'NO_HEAD' });
  }, 30000);

  it('stages and unstages explicit single/bulk paths on unborn HEAD without touching other files', async () => {
    for (const rel of ['a.txt', '中文 space.txt', '[literal].txt', '-option.txt', 'keep.txt']) await write(rel, `${rel}\n`);
    await call('stage', { paths: ['keep.txt'] });
    await call('stage', { paths: ['a.txt', '中文 space.txt', '[literal].txt', '-option.txt'] });
    expect(await command(['ls-files', '-z'])).toContain('keep.txt\0');
    expect((await call<ManagementText>('diff', { scope: 'staged', paths: ['a.txt'] })).text).toContain('+a.txt');
    await call('unstage', { paths: ['a.txt', '中文 space.txt', '[literal].txt', '-option.txt'] });
    expect(await command(['ls-files', '-z'])).toBe('keep.txt\0');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('a.txt\n');
    expect((await call<ManagementText>('diff', { scope: 'workspace', paths: ['a.txt'] })).text).toContain('+a.txt');
  }, 30000);

  it('rejects traversal, directories, sensitive paths and symlink ancestors before mutation', async () => {
    await write('folder/a.txt', 'safe'); await write('.env.local', 'secret');
    for (const rel of ['.', 'folder', '../outside', '.git/config', '.env.local', 'folder/../a.txt', 'C:/outside']) {
      await expect(call('stage', { paths: [rel] })).rejects.toBeDefined();
    }
    await expect(call('stage', { paths: [] })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await fs.mkdir(path.join(container, 'outside'));
    await fs.symlink(path.join(container, 'outside'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(call('stage', { paths: ['link/file.txt'] })).rejects.toMatchObject({ code: 'SYMLINK_DENIED' });
    expect(await command(['ls-files'])).toBe('');
  }, 30000);

  it('commits staged content only and preserves partially staged, unrelated and untracked edits', async () => {
    await fixture(); await write('a.txt', 'staged\n'); await call('stage', { paths: ['a.txt'] });
    await write('a.txt', 'unstaged\n'); await write('other.txt', 'untracked\n');
    const status = await call<ManagementStatus>('status');
    expect(status.entries.find(e => e.path === 'a.txt')).toMatchObject({ index: 'M', working: 'M' });
    expect((await call<ManagementText>('diff', { scope: 'workspace', paths: ['a.txt'] })).text).toContain('+unstaged');
    expect((await call<ManagementText>('diff', { scope: 'staged', paths: ['a.txt'] })).text).toContain('+staged');
    await expect(call('commit', { message: 'selected' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await call('commit', { message: 'selected', ...confirm });
    expect(await command(['show', 'HEAD:a.txt'])).toBe('staged\n');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('unstaged\n');
    expect(await command(['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('other.txt');
    await expect(call('commit', { message: 'empty', ...confirm })).rejects.toMatchObject({ code: 'NOTHING_STAGED' });
  }, 30000);

  it('runs configured commit hooks and reports rejection without false success', async () => {
    await write('a.txt', 'new\n'); await call('stage', { paths: ['a.txt'] });
    await write('.git/hooks/pre-commit', '#!/bin/sh\necho hook-blocked >&2\nexit 1\n');
    await fs.chmod(path.join(root, '.git/hooks/pre-commit'), 0o755);
    await expect(call('commit', { message: 'blocked', ...confirm })).rejects.toThrow('hook-blocked');
    expect((await call<ManagementStatus>('status')).head).toBeNull();
    await write('.git/hooks/pre-commit', '#!/bin/sh\necho ran > .git/hook-ran\n');
    await call('commit', { message: 'allowed', ...confirm });
    expect(await fs.readFile(path.join(root, '.git/hook-ran'), 'utf8')).toContain('ran');
    expect((await call<ManagementStatus>('status')).head).toMatch(/^[a-f0-9]{40}$/);
  }, 30000);

  it('supports branch create/switch/rename/safe-delete and blocks dirty switches and unmerged deletion', async () => {
    await fixture(); await call('branchCreate', { name: 'feature' });
    expect(await call('branches')).toMatchObject({ branches: expect.arrayContaining([expect.objectContaining({ name: 'feature' })]) });
    await write('dirty.txt', 'keep');
    await expect(call('branchSwitch', { name: 'feature', ...confirm })).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    await fs.unlink(path.join(root, 'dirty.txt'));
    await call('branchSwitch', { name: 'feature', ...confirm });
    await call('branchRename', { name: 'feature', newName: 'renamed', ...confirm });
    expect((await call<ManagementStatus>('status')).branch).toBe('renamed');
    await write('a.txt', 'feature\n'); await call('stage', { paths: ['a.txt'] }); await call('commit', { message: 'feature', ...confirm });
    await call('branchSwitch', { name: 'main', ...confirm });
    await expect(call('branchDelete', { name: 'renamed', ...confirm })).rejects.toMatchObject({ code: 'UNMERGED_BRANCH' });
    await call('branchCreate', { name: 'safe' });
    await expect(call('branchDelete', { name: 'safe' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await call('branchDelete', { name: 'safe', ...confirm });
    await expect(call('branchCreate', { name: '--force' })).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(call('branchCreate', { name: '@{-1}' })).rejects.toMatchObject({ code: 'INVALID_REF' });
  }, 60000);

  it('provides paginated history, root/ordinary commit patches and committed blame', async () => {
    await fixture(); const first = (await command(['rev-parse', 'HEAD'])).trim();
    await write('a.txt', 'second\n'); await call('stage', { paths: ['a.txt'] }); await call('commit', { message: 'second', ...confirm });
    expect(await call('history', { limit: 1 })).toMatchObject({ commits: [expect.objectContaining({ subject: 'second' })], hasMore: true });
    expect(await call('history', { limit: 1, skip: 1 })).toMatchObject({ commits: [expect.objectContaining({ oid: first })], hasMore: false });
    expect((await call<ManagementText>('commitDiff', { ref: first })).text).toContain('+base');
    expect((await call<ManagementText>('commitDiff', { ref: 'HEAD' })).text).toContain('+second');
    await write('a.txt', 'workspace\n');
    const blame = await call<ManagementText>('blame', { path: 'a.txt' }); expect(blame.text).toContain('second'); expect(blame.text).not.toContain('workspace');
  }, 30000);

  it('creates/lists/shows/applies/pops/drops stashes and rejects stale IDs and empty stash', async () => {
    await fixture();
    await expect(call('stashCreate', confirm)).rejects.toMatchObject({ code: 'NOTHING_TO_STASH' });
    await write('a.txt', 'stash edit\n'); await write('new.txt', 'new stash\n');
    await call('stashCreate', { ...confirm, includeUntracked: true, message: 'saved' });
    expect((await call<ManagementStatus>('status')).entries).toEqual([]);
    let stash = (await stashList())[0]; expect(stash.subject).toContain('saved');
    expect((await call<ManagementText>('stashShow', stash)).text).toContain('new stash');
    await expect(call('stashDrop', { ...stash, oid: 'bad', ...confirm })).rejects.toMatchObject({ code: 'STALE_STASH' });
    await call('stashApply', { ...stash, ...confirm });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('stash edit\n'); expect(await stashList()).toHaveLength(1);
    await expect(call('stashApply', { ...stash, ...confirm })).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    await call('stashDrop', { ...stash, ...confirm }); expect(await stashList()).toHaveLength(0);
    await call('stashCreate', { ...confirm, includeUntracked: true }); stash = (await stashList())[0];
    await call('stashPop', { ...stash, ...confirm }); expect(await stashList()).toHaveLength(0);
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new stash\n');
  }, 60000);

  it('reports stash conflicts, preserves the stash and exposes conflict status', async () => {
    await fixture(); await write('a.txt', 'stash version\n'); await call('stashCreate', confirm);
    const stash = (await stashList())[0];
    await write('a.txt', 'committed version\n'); await call('stage', { paths: ['a.txt'] }); await call('commit', { message: 'other version', ...confirm });
    await expect(call('stashPop', { ...stash, ...confirm })).rejects.toMatchObject({ code: 'STASH_CONFLICT' });
    expect(await stashList()).toHaveLength(1);
    expect((await call<ManagementStatus>('status')).entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'a.txt', index: 'U', working: 'U' })]));
    await expect(call('commit', { message: 'bad', ...confirm })).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 30000);

  it('unstages tracked deletion and rename paths without changing working files', async () => {
    await fixture(); await fs.rename(path.join(root, 'a.txt'), path.join(root, 'renamed.txt'));
    await call('stage', { paths: ['a.txt', 'renamed.txt'] });
    await call('unstage', { paths: ['a.txt', 'renamed.txt'] });
    expect(await command(['ls-files', '-z'])).toBe('a.txt\0');
    expect(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8')).toBe('base\n');
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);
});
