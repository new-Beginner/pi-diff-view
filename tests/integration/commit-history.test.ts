import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../src/git/runner';
import { dispatch, type ManagementArgs, type ManagementCommitFiles, type ManagementText } from '../../src/git/local-management';

let root: string;
const command = async (args: string[]) => (await git(root, ['-c', 'user.name=History Test', '-c', 'user.email=history@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args])).stdout.toString().trim();
const call = <T>(operation: string, args: Partial<ManagementArgs> = {}) => dispatch('gitManage', { operation, root, ref: 'HEAD', ...args }, [root]) as Promise<T>;
const write = (name: string, text: string | Buffer) => fs.writeFile(path.join(root, name), text);
const commit = async (message = 'fixture') => { await command(['add', '--all']); await command(['commit', '-m', message]); return command(['rev-parse', 'HEAD']); };
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw Error('Session scratch is required');
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'commit-history-'));
  await command(['init', '-b', 'main']);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('lists initial/ordinary commit files and previews only the selected historical file without writes', async () => {
  await write('a.txt', 'base\n'); await write('deleted.txt', 'deleted\n'); await write('old.txt', 'rename\n');
  const first = await commit('initial');
  expect(await call<ManagementCommitFiles>('commitFiles')).toMatchObject({ oid: first, parent: null, entries: expect.arrayContaining([{ path: 'a.txt', status: 'A', additions: 1, deletions: 0 }]) });
  await write('a.txt', 'second\n'); await fs.unlink(path.join(root, 'deleted.txt'));
  await fs.rename(path.join(root, 'old.txt'), path.join(root, '中文 space [literal].txt'));
  await write('binary.dat', Buffer.from([0, 1, 2])); await write('empty.txt', '');
  const second = await commit('second');
  await write('a.txt', 'staged\n'); await command(['add', '--', 'a.txt']); await write('a.txt', 'working\n');
  // Today's directory with the same name must not obstruct a historical deleted file.
  await fs.mkdir(path.join(root, 'deleted.txt'));
  const index = await fs.readFile(path.join(root, '.git/index')), before = await command(['status', '--porcelain=v1']);
  const result = await call<ManagementCommitFiles>('commitFiles');
  expect(result).toMatchObject({ oid: second, parent: first, entries: expect.arrayContaining([
    { path: 'a.txt', status: 'M', additions: 1, deletions: 1 },
    { path: 'deleted.txt', status: 'D', additions: 0, deletions: 1 },
    { path: 'old.txt', status: 'D', additions: 0, deletions: 1 },
    { path: '中文 space [literal].txt', status: 'A', additions: 1, deletions: 0 },
    { path: 'empty.txt', status: 'A', additions: 0, deletions: 0 },
    { path: 'binary.dat', status: 'A', additions: null, deletions: null, kind: 'binary' },
  ]) });
  const patch = await call<ManagementText>('commitDiff', { path: 'a.txt' });
  expect(patch.text).toContain('-base\n+second'); expect(patch.text).not.toMatch(/staged|working|binary.dat/);
  expect((await call<ManagementText>('commitDiff', { path: 'deleted.txt' })).text).toContain('-deleted');
  expect((await call<ManagementText>('commitDiff', { ref: first, path: 'a.txt' })).text).toContain('+base');
  expect((await call<ManagementText>('commitDiff', { path: '中文 space [literal].txt' })).text).toContain('+rename');
  expect((await call<ManagementText>('commitDiff', { path: 'binary.dat' })).text).toContain('Binary files');
  expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(index);
  expect(await command(['status', '--porcelain=v1'])).toBe(before);
  expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('working\n');
}, 30000);

it('uses the first parent of a merge and handles empty commits', async () => {
  await write('base.txt', 'base\n'); await commit(); await command(['checkout', '-b', 'feature']);
  await write('feature.txt', 'feature\n'); await commit('feature'); await command(['checkout', 'main']);
  await write('main.txt', 'main\n'); const parent = await commit('main');
  await command(['merge', '--no-ff', '-m', 'merge', 'feature']);
  expect(await call<ManagementCommitFiles>('commitFiles')).toMatchObject({ parent, entries: [{ path: 'feature.txt', status: 'A', additions: 1, deletions: 0 }] });
  expect((await call<ManagementText>('commitDiff', { path: 'feature.txt' })).text).toContain('+feature');
  await command(['commit', '--allow-empty', '-m', 'empty']);
  expect((await call<ManagementCommitFiles>('commitFiles')).entries).toEqual([]);
  await expect(call('commitDiff', { path: 'feature.txt' })).rejects.toMatchObject({ code: 'STALE_PATH' });
}, 30000);

it('blocks historical secrets, symlinks and submodules independently while safe files remain readable', async () => {
  await write('safe.txt', 'safe\n'); const first = await commit();
  await write('.env.local', 'secret-content\n'); await write('safe.txt', 'safe second\n');
  await command(['add', '--all']);
  const blob = await command(['hash-object', '-w', '--', 'safe.txt']);
  await command(['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  await command(['update-index', '--add', '--cacheinfo', `160000,${first},module`]);
  await command(['commit', '-m', 'mixed']);
  const result = await call<ManagementCommitFiles>('commitFiles');
  for (const name of ['.env.local', 'link', 'module']) {
    expect(result.entries.find(e => e.path === name)?.blocked).toBeTruthy();
    await expect(call('commitDiff', { path: name })).rejects.toMatchObject({ code: 'PATH_DENIED' });
  }
  expect(JSON.stringify(result)).not.toContain('secret-content');
  expect((await call<ManagementText>('commitDiff', { path: 'safe.txt' })).text).toContain('+safe second');
  for (const name of ['../safe.txt', '/safe.txt', 'C:/safe.txt', 'a/../safe.txt', 'a\\b', '.git/config']) await expect(call('commitDiff', { path: name })).rejects.toBeDefined();
  await expect(call('commitFiles', { ref: '--all' })).rejects.toBeDefined();
  await expect(dispatch('gitManage', { operation: 'commitFiles', root, ref: first }, [])).rejects.toMatchObject({ code: 'ROOT_DENIED' });
}, 30000);

it('bounds each patch independently instead of truncating later files from a large commit', async () => {
  await write('a-large.txt', 'long line content\n'.repeat(4000)); await write('z-small.txt', 'last-file\n'); await commit();
  expect((await call<ManagementCommitFiles>('commitFiles')).entries).toHaveLength(2);
  expect((await call<ManagementText>('commitDiff', { path: 'a-large.txt' })).truncated).toBe(true);
  const small = await call<ManagementText>('commitDiff', { path: 'z-small.txt' });
  expect(small.truncated).toBe(false); expect(small.text).toContain('+last-file');
}, 30000);

it('refuses an over-budget file list explicitly instead of silently omitting files', async () => {
  await Promise.all(Array.from({ length: 501 }, (_, i) => write(`file-${i}.txt`, 'file\n'))); await commit();
  await expect(call('commitFiles')).rejects.toMatchObject({ code: 'GIT_LIMIT' });
  expect((await call<ManagementText>('commitDiff', { path: 'file-500.txt' })).text).toContain('+file');
}, 30000);
