import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReviewService } from '../../src/core/review-service';
import { SnapshotStore } from '../../src/core/storage';
import { dispatch } from '../../src/git/local-management';
import { scanRepositories, workspaceRoots } from '../../src/git/discovery';

const exec = promisify(execFile);
let temp: string, root: string, a: string, b: string, store: SnapshotStore, service: ReviewService;
async function init(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: directory, windowsHide: true });
}
function fresh(workspace = root) {
  return new ReviewService(store, { workspace: async () => ({ path: workspace }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, 'test');
}
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR required');
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'multi-repository-'));
  root = path.join(temp, 'projects'); a = path.join(root, 'a'); b = path.join(root, 'group', '中文 b');
  await init(a); await init(b);
  store = new SnapshotStore(path.join(temp, 'data')); await store.init(); service = fresh();
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

it('discovers nested repositories, deduplicates roots and ignores invalid markers/dependencies', async () => {
  await init(path.join(root, 'node_modules', 'ignored'));
  await fs.mkdir(path.join(root, 'invalid', '.git'), { recursive: true });
  const boot = await service.bootstrap('session-a');
  expect(boot.repositories.filter(repo => repo.git).map(repo => repo.root)).toEqual([a, b]);
  expect(boot.repositories.filter(repo => !repo.git).map(repo => repo.root)).toEqual([root]);
}, 30000);

it('accepts a selected descendant but never an enclosing/outside repository or directory link', async () => {
  expect(await dispatch('gitManage', { operation: 'status', root: b }, [root])).toMatchObject({ root: b });
  expect(await service.review({ scope: 'unstaged', root: b })).toMatchObject({ root: b });
  await expect(dispatch('gitManage', { operation: 'status', root: root }, [a])).rejects.toMatchObject({ code: 'ROOT_DENIED' });
  const outside = path.join(temp, 'outside'); await init(outside);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await service.bootstrap()).repositories.some(repo => repo.root === outside)).toBe(false);
  await expect(dispatch('gitManage', { operation: 'status', root: path.join(root, 'linked') }, [root])).rejects.toBeDefined();
  await expect(dispatch('gitManage', { operation: 'status', root: outside }, [root])).rejects.toMatchObject({ code: 'ROOT_DENIED' });
}, 30000);

it('recognizes worktrees with a .git file', async () => {
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'initial'], { cwd: a, windowsHide: true });
  const worktree = path.join(root, 'worktree');
  await exec('git', ['worktree', 'add', '-b', 'other', worktree], { cwd: a, windowsHide: true });
  expect((await service.bootstrap()).repositories).toContainEqual(expect.objectContaining({ root: worktree, git: true }));
}, 30000);

it('persists session/workspace choices across service reloads without leaking other workspace preferences', async () => {
  await service.invoke('selectRepository', { sessionId: 'session-a', root: b });
  await service.invoke('selectRepository', { sessionId: 'session-b', root: a });
  service = fresh();
  expect(await service.bootstrap('session-a')).toMatchObject({ selectedRepository: b });
  expect(await service.bootstrap('session-b')).toMatchObject({ selectedRepository: a });
  expect(await fresh(a).bootstrap('session-a')).toMatchObject({ selectedRepository: a });
  await expect(service.invoke('selectRepository', { sessionId: 'session-a', root: temp })).rejects.toBeDefined();
  await expect(service.invoke('selectRepository', { sessionId: 'session-a', root: a, workspaceKey: 'stale-workspace' })).rejects.toMatchObject({ code: 'ROOT_DENIED' });
}, 30000);

it('does not silently switch to the first repository when the remembered repository disappears', async () => {
  await service.invoke('selectRepository', { sessionId: 'session-a', root: b });
  await fs.rm(b, { recursive: true, force: true });
  const boot = await fresh().bootstrap('session-a');
  expect(boot).toMatchObject({ selectedRepository: b });
  expect(boot.repositories.some(repo => repo.root === b)).toBe(false);
}, 30000);

it('deduplicates overlapping workspace roots and reports bounded-depth scans', async () => {
  expect(workspaceRoots({ path: root, roots: [root, { path: a }, a] })).toEqual([root, a]);
  const deep = path.join(root, ...Array.from({ length: 7 }, (_, i) => `level-${i}`)); await init(deep);
  const result = await scanRepositories([root, a]);
  expect(result.repositories.filter(repo => repo.root === a)).toHaveLength(1);
  expect(result.repositories.some(repo => repo.root === deep)).toBe(false);
  expect(result.repositoryNotice).toContain('上限');
}, 30000);
