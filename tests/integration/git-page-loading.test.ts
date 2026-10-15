import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { LocalGitManagement } from '../../src/git/local-management';
import { git } from '../../src/git/runner';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
let root: string;
const management = new LocalGitManagement();
const command = (args: string[]) => git(root, ['-c', 'user.name=Page Test', '-c', 'user.email=page@example.invalid', ...args]);
const invoke = (operation: string, options: Record<string, unknown> = {}) => management.dispatch('gitManage', { root, operation, ...options }, [root]) as Promise<any>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'git-page-loading-'));
  await command(['init', '-b', 'main']);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('lists branches and history with lightweight repository info even above the status file budget', async () => {
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n'); await command(['add', '--all']); await command(['commit', '-m', 'base']);
  await fs.mkdir(path.join(root, 'deep/path'), { recursive: true });
  await Promise.all(Array.from({ length: 501 }, (_, i) => fs.writeFile(path.join(root, `deep/path/${i}.txt`), 'untracked\n')));
  await expect(invoke('status')).rejects.toMatchObject({ code: 'GIT_LIMIT' });
  for (const operation of ['branches', 'history', 'stashList']) {
    vi.mocked(spawn).mockClear();
    const value = await invoke(operation, { includeRepository: true });
    expect(value.repository).toMatchObject({ root: await fs.realpath(root), branch: 'main', head: expect.stringMatching(/^[a-f0-9]{40,64}$/) });
    const calls = vi.mocked(spawn).mock.calls.map(call => call[1] as string[]);
    expect(calls.some(args => args.includes('status'))).toBe(false);
    expect(calls.filter(args => args.includes('--show-toplevel'))).toHaveLength(1);
    expect(calls.some(args => args.includes('--numstat') || args.includes('diff-tree'))).toBe(false);
    if (operation === 'history') expect(value.commits[0].subject).toBe('base');
    if (operation === 'branches') expect(value.branches[0].name).toBe('main');
  }
});
it('lightweight status handles unborn and detached HEAD without scanning files', async () => {
  vi.mocked(spawn).mockClear();
  expect(await invoke('status', { summaryOnly: true })).toEqual({ root: await fs.realpath(root), branch: 'main', head: null, entries: [] });
  expect((await invoke('history', { includeRepository: true })).repository.head).toBeNull();
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n'); await command(['add', '--all']); await command(['commit', '-m', 'base']); await command(['checkout', '--detach']);
  vi.mocked(spawn).mockClear();
  const value = await invoke('history', { includeRepository: true });
  expect(value.repository.branch).toBeNull(); expect(value.repository.head).toBe(value.commits[0].oid);
  expect(vi.mocked(spawn).mock.calls.some(call => (call[1] as string[]).includes('status'))).toBe(false);
});
it('lightweight reads retain root authorization and mutation confirmation', async () => {
  await expect(management.dispatch('gitManage', { root, operation: 'history', includeRepository: true }, [])).rejects.toMatchObject({ code: 'ROOT_DENIED' });
  await expect(invoke('branchSwitch', { name: 'other', includeRepository: true })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
});
it('piggybacks bounded untracked statistics without starting diff or ls-files', async () => {
  await fs.writeFile(path.join(root, 'note.txt'), 'one\ntwo\n');
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1]));
  await fs.writeFile(path.join(root, '.env.local'), 'SECRET=private\n');
  vi.mocked(spawn).mockClear();
  const value = await invoke('status', { includeStats: true });
  expect(value.entries.find((e: any) => e.path === 'note.txt').stats).toEqual({ path: 'note.txt', additions: 2, deletions: 0 });
  expect(value.entries.find((e: any) => e.path === 'empty.txt').stats).toEqual({ path: 'empty.txt', additions: 0, deletions: 0 });
  expect(value.entries.find((e: any) => e.path === 'binary.dat').stats.kind).toBe('binary');
  expect(value.entries.find((e: any) => e.path === '.env.local').stats).toBeUndefined();
  const calls = vi.mocked(spawn).mock.calls.map(call => call[1] as string[]);
  expect(calls.some(args => args.includes('--numstat') || args.includes('ls-files'))).toBe(false);
  await fs.writeFile(path.join(root, 'note.txt'), 'changed\n');
  expect((await invoke('status', { includeStats: true })).entries.find((e: any) => e.path === 'note.txt').stats.additions).toBe(1);
  expect((await invoke('status')).entries.every((e: any) => !e.stats)).toBe(true);
});
it('defers oversized and excess inline candidates, and skips numstat for untracked-only batches', async () => {
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(20000));
  await Promise.all(Array.from({ length: 20 }, (_, i) => fs.writeFile(path.join(root, `small-${i}.txt`), 'line\n')));
  const value = await invoke('status', { includeStats: true });
  expect(value.entries.find((e: any) => e.path === 'large.txt').stats).toBeUndefined();
  expect(value.entries.filter((e: any) => e.stats).length).toBeLessThanOrEqual(16);
  vi.mocked(spawn).mockClear();
  expect((await invoke('stats', { scope: 'workspace', paths: ['large.txt'] })).entries).toEqual([{ path: 'large.txt', additions: 1, deletions: 0 }]);
  expect(vi.mocked(spawn).mock.calls.some(call => (call[1] as string[]).includes('--numstat'))).toBe(false);
});
