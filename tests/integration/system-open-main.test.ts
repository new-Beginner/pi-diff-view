import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun, ReviewSummary } from '../../src/core/contracts';

it('built main opens only validated current session files, including unavailable diffs, outside serial history work', async () => {
  const directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'system-open-main-'));
  const data = path.join(directory, 'data'), root = path.join(directory, 'project'), outside = path.join(directory, 'outside'), entry = path.join(directory, 'main.cjs');
  await fs.mkdir(root); await fs.mkdir(outside);
  const name = "中文 空格 ' & $(literal).txt", unavailable = { exists: true, text: null, hash: 'unknown', size: 12, mode: 0o100644, kind: 'unavailable' as const };
  const changes: CaptureRun['changes'] = Object.fromEntries([name, 'report.pdf', 'missing.txt', 'linked/item.txt', 'new-name.txt'].map(value => [value, { before: snapshotOfText('old\n'), after: value === 'report.pdf' ? unavailable : snapshotOfText('new\n') }]));
  const store = new SnapshotStore(data); await store.init();
  const run: CaptureRun = { version: 1, id: 'system-open-run', generation: 'old', sessionId: 's', root, startedAt: Date.now(), endedAt: Date.now(), state: 'completed', incomplete: false, fileCount: 5, changes, replies: [], bindings: {} };
  await store.writeRun(run);
  expect(await store.getRun(run.id, false, false)).not.toBeNull();
  await fs.writeFile(path.join(root, name), 'current, not the historical snapshot');
  await fs.writeFile(path.join(root, 'report.pdf'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, '.env'), 'private');
  await fs.writeFile(path.join(root, 'old-name.txt'), 'old path must not be used');
  await fs.writeFile(path.join(outside, 'item.txt'), 'outside');
  await fs.symlink(outside, path.join(root, 'linked'), 'junction');
  const opened: string[] = [], launch = vi.fn(async (value: string, options: { validate: () => Promise<void>; signal: AbortSignal }) => {
    await options.validate(); if (options.signal.aborted) throw new Error('unloaded'); opened.push(value); return { ok: true };
  });
  const previousPi = (globalThis as any).pi, previousLaunch = (globalThis as any).__systemOpenTest, previousLifecycle = (globalThis as any).__systemOpenLifecycle;
  const lifecycle: string[] = [];
  (globalThis as any).__systemOpenLifecycle = (phase: string) => lifecycle.push(phase);
  (globalThis as any).__systemOpenTest = launch;
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'], plugins: [{ name: 'mock-os-launch', setup(builder) {
    builder.onLoad({ filter: /[\\/]system-open\.ts$/ }, () => ({ contents: 'export const openSystemFile = (path, options) => globalThis.__systemOpenTest(path, options); export const warmSystemOpener = () => globalThis.__systemOpenLifecycle("warm"); export const closeSystemOpener = () => globalThis.__systemOpenLifecycle("close");', loader: 'js' }));
  } }] });
  const home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  const workspace = vi.fn(async () => ({ path: root }));
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: workspace }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); let loaded = false;
  try {
    await plugin.onLoad(); loaded = true;
    const review: ReviewSummary = await plugin.onPanelInvoke('diff.review', { scope: 'turn', sessionId: 's', runId: run.id, root });
    const args = (value: string) => ({ reviewId: review.id, fileId: review.files.find(file => file.path === value)!.id, sessionId: 's' });
    expect(lifecycle).toEqual(['warm']); expect(opened).toEqual([]);
    let release!: () => void;
    workspace.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ path: root }); }));
    const blocked = plugin.onPanelInvoke('diff.bootstrap', {});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      const job = await plugin.onRendererCall('jobStart', { method: 'openSystemFile', args: args(name), waitMs: 40 });
      await vi.waitFor(async () => expect((await plugin.onRendererCall('jobPoll', job)).state).toBe('done'));
      expect(opened).toEqual([path.join(root, name)]);
    } finally { release(); await blocked; }
    expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('current, not the historical snapshot');
    expect(review.files.find(file => file.path === 'report.pdf')!.kind).toBe('unavailable');
    await expect(plugin.onRendererCall('openSystemFile', args('report.pdf'))).resolves.toEqual({ ok: true });
    expect(opened.at(-1)).toBe(path.join(root, 'report.pdf'));
    const count = opened.length;
    await expect(plugin.onPanelInvoke('diff.openSystemFile', { ...args(name), sessionId: 'other' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', { ...args(name), fileId: 'fake', path: path.join(root, name), command: 'anything' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', args('missing.txt'))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', message: expect.stringContaining('文件已不存在') });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', { ...args(name), fileId: '.env', path: path.join(root, '.env') })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', args('new-name.txt'))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', args('linked/item.txt'))).rejects.toMatchObject({ code: 'SYMLINK_DENIED' });
    expect(opened).toHaveLength(count);
    launch.mockImplementationOnce(async (_value, options) => { await fs.rm(path.join(root, name)); await options.validate(); return { ok: true }; });
    await expect(plugin.onPanelInvoke('diff.openSystemFile', args(name))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(opened).toHaveLength(count);
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);
    try { await expect(plugin.onPanelInvoke('diff.openSystemFile', args('report.pdf'))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' }); }
    finally { clock.mockRestore(); }
    await plugin.onUnload(); loaded = false;
    expect(lifecycle).toEqual(['warm', 'close']);
    await expect(plugin.onRendererCall('openSystemFile', args('report.pdf'))).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  } finally {
    if (loaded) await plugin.onUnload(); home.mockRestore();
    (globalThis as any).pi = previousPi; (globalThis as any).__systemOpenTest = previousLaunch; (globalThis as any).__systemOpenLifecycle = previousLifecycle;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
