import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(files = 1) {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'saved-read-'));
  const root = path.join(temp, 'project'), data = path.join(temp, 'host/plugins/data/local.diff-view');
  await fs.mkdir(root);
  const store = new SnapshotStore(data); await store.init();
  const run: CaptureRun = { version: 2, id: 'saved-run', generation: 'old', sessionId: 'saved-session', root, boundary: 'user', userMessageId: 'saved-user', replyMessageId: 'saved-reply', startedAt: Date.now() - 10000, endedAt: Date.now() - 5000, state: 'completed', incomplete: false, fileCount: files, contentVersion: 1, changes: {}, replies: [], bindings: {} };
  for (let i = 0; i < files; i++) {
    const value = `file-${i}.txt`, absolutePath = path.join(root, value), identity = canonical(absolutePath);
    run.changes[value] = { capture: { id: digest(identity).slice(0, 24), identity, path: value, absolutePath, origin: 'workspace' }, before: snapshotOfText('old\n'), after: snapshotOfText('new\n'), evidence: ['edit:saved-call'] };
  }
  await store.writeRun(run);
  const workspace = vi.fn(async () => ({ path: root }));
  const host = { workspace, settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} };
  await new ReviewService(store, host, 'old').replyCards({ sessionId: run.sessionId });
  await fs.writeFile(path.join(data, 'session-roots.json'), JSON.stringify({ [run.sessionId]: root }));
  const entry = path.join(temp, 'main.cjs');
  await build({ stdin: { contents: "export * from './src/main'; export { HostHistoryImporter } from './src/core/host-history'; export { SnapshotStore } from './src/core/storage';", resolveDir: process.cwd(), loader: 'ts' }, outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const previous = (globalThis as any).pi;
  vi.spyOn(os, 'homedir').mockReturnValue(temp);
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: host.settings }, workspace: { get: workspace }, app: { getAppearance: host.appearance }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = vi.spyOn(plugin.HostHistoryImporter.prototype, 'syncSession').mockImplementation(async () => {
    await gate;
    return { imported: 0, unchanged: 1, skipped: 0, events: 1, runIds: [run.id], warnings: [] };
  });
  await plugin.onLoad();
  cleanups.push(async () => { release(); await plugin.onUnload(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); });
  const reviewArgs = { scope: 'turn', sessionId: run.sessionId, runId: run.id, root };
  const job = async (method: string, args: unknown) => {
    const started = await plugin.onRendererCall('jobStart', { method, args, waitMs: 40 });
    let result = started;
    await expect.poll(async () => {
      result = await plugin.onRendererCall('jobPoll', { jobId: started.jobId });
      return result.state;
    }, { timeout: 1000, interval: 10 }).not.toBe('pending');
    if (result.state === 'error') throw new Error(result.error.message);
    return result.result;
  };
  return { plugin, store, run, root, workspace, sync, release, reviewArgs, job };
}
it('reads saved cards, a pinned task and its detail while history sync is blocked, without authorizing mutations', async () => {
  const f = await fixture(121);
  const recorded = (await f.store.getRun(f.run.id, false, false))!;
  delete recorded.cardPreview; await f.store.writeRun(recorded);
  const context = f.plugin.onRendererCall('sessionContext', { sessionId: f.run.sessionId, root: f.root, running: false });
  await expect.poll(() => f.sync.mock.calls.length).toBe(1);
  f.workspace.mockClear();
  const page = await f.job('replyCards', { sessionId: f.run.sessionId });
  expect(page.cards[0].messageId).toBe(f.run.replyMessageId);
  expect((await f.store.getRun(f.run.id, false, false))?.cardPreview).toBeUndefined();
  const summary = await f.job('review', f.reviewArgs);
  expect(summary.sync).toMatchObject({ state: 'pending', saved: true });
  expect(summary.files.length).toBeGreaterThan(0); expect(summary.files.every((file: any) => !file.actions.length)).toBe(true);
  expect(f.workspace).not.toHaveBeenCalled();
  const continuation = await f.plugin.onRendererCall('reviewFiles', { reviewId: summary.id, offset: summary.nextFileOffset });
  expect(continuation.files.at(-1).path).toBe('file-120.txt');
  const fileId = f.run.changes['file-120.txt'].capture!.id;
  const detail = await f.plugin.onRendererCall('file', { reviewId: summary.id, fileId });
  expect(detail.hunks[0].lines.some((line: any) => line.text === 'new')).toBe(true);
  expect(detail.file.actions).toEqual([]);
  expect(f.sync).toHaveBeenCalledTimes(1);
  f.release(); await context;
  const ready = await f.plugin.onRendererCall('review', f.reviewArgs);
  expect(ready.sync.state).toBe('ready'); expect(ready.files[0].actions).toContain('revert');
  // Loading a normally authorized review cannot upgrade the old read-only cache.
  expect((await f.plugin.onRendererCall('file', { reviewId: summary.id, fileId: summary.files[0].id })).file.actions).toEqual([]);
  await expect(f.plugin.onRendererCall('action', { reviewId: summary.id, fileId, action: 'revert', fingerprint: detail.file.fingerprint, confirmed: true })).rejects.toThrow();
  expect(f.sync).toHaveBeenCalledTimes(1);
});
it('coalesces cold saved reads and records completion time rather than expiring during a slow sync', async () => {
  const f = await fixture();
  const realNow = Date.now; let offset = 0; vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  const first = await f.job('review', f.reviewArgs);
  expect(first.sync).toMatchObject({ state: 'pending', saved: true });
  await expect.poll(() => f.sync.mock.calls.length).toBe(1);
  const second = await f.job('review', f.reviewArgs);
  expect(second.id).toBe(first.id);
  expect(f.sync).toHaveBeenCalledTimes(1);
  offset += 5000; f.release();
  await expect.poll(async () => (await f.plugin.onRendererCall('review', f.reviewArgs)).sync.state).toBe('ready');
  await f.plugin.onRendererCall('review', f.reviewArgs);
  expect(f.sync).toHaveBeenCalledTimes(1);
  const other = await f.plugin.onRendererCall('review', { ...f.reviewArgs, sessionId: 'other-session' });
  expect(other.files).toEqual([]);
  await expect(f.plugin.onRendererCall('review', { ...f.reviewArgs, root: path.dirname(f.root) })).rejects.toThrow(/authorized|授权/);
});
it('fences an in-flight saved read before clearing history and never resurrects its cache', async () => {
  const f = await fixture();
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  const original = f.plugin.SnapshotStore.prototype.inspect;
  vi.spyOn(f.plugin.SnapshotStore.prototype, 'inspect').mockImplementation(async function (this: SnapshotStore, ...args: unknown[]) {
    entered = true; await gate; return original.apply(this, args);
  });
  const reading = f.plugin.onRendererCall('review', f.reviewArgs);
  const rejected = expect(reading).rejects.toThrow(/cleared|unloaded/);
  await expect.poll(() => entered).toBe(true);
  let cleared = false;
  const clearing = f.plugin.onRendererCall('clearHistory', { confirmed: true }).then(() => { cleared = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(cleared).toBe(false);
  release(); await rejected; await clearing;
  expect((await f.plugin.onRendererCall('replyCards', { sessionId: f.run.sessionId })).cards).toEqual([]);
  expect(f.sync).not.toHaveBeenCalled();
});
