import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import { dispatch, type ManagementStatus } from '../../src/git/local-management';
import type { CaptureRun } from '../../src/core/contracts';
afterEach(() => vi.restoreAllMocks());
const temporary = () => fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'app-performance-'));
const host = (root: string) => ({ workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} });

it('deduplicates summary blob reads while still rejecting equal-length corrupt content', async () => {
  const directory = await temporary();
  try {
    const root = path.join(directory, 'project'); await fs.mkdir(root);
    const store = new SnapshotStore(path.join(directory, 'data')); await store.init();
    const before = snapshotOfText('old\n'), after = snapshotOfText('new\n');
    const run: CaptureRun = { version: 2, boundary: 'user', id: 'summary-many', generation: 'g', sessionId: 's', root, startedAt: 1, endedAt: 2, state: 'completed', fileCount: 256, incomplete: false, changes: {}, replies: [], bindings: {} };
    for (let i = 0; i < 256; i++) {
      const value = `file-${i}.txt`, absolutePath = path.join(root, value), identity = canonical(absolutePath);
      run.changes[value] = { before, after, capture: { id: digest(identity).slice(0, 24), identity, absolutePath, path: value, origin: 'workspace' } };
    }
    await store.writeRun(run);
    let service = new ReviewService(store, host(root), 'g');
    const hydrate = vi.spyOn(store, 'hydrate'), started = performance.now();
    const summary = await service.turnSummary({ runId: run.id, sessionId: 's', limit: 100 });
    console.log(`PERF summary=256 files elapsed=${(performance.now() - started).toFixed(1)}ms hydrated=${hydrate.mock.calls.length}`);
    expect(summary).toMatchObject({ fileCount: 256, additions: 256, deletions: 256, unknownFileCount: 0 });
    expect(hydrate).toHaveBeenCalledTimes(2); expect(summary.files[0].path).toBe('file-0.txt');
    await fs.writeFile(path.join(store.directory, 'blobs', after.hash), 'bad\n');
    service = new ReviewService(store, host(root), 'g'); hydrate.mockClear();
    const corrupt = await service.turnSummary({ runId: run.id, sessionId: 's' });
    expect(corrupt).toMatchObject({ unknownFileCount: 256, additions: 0, deletions: 0 });
    expect(corrupt.files[0].kind).toBe('unavailable'); expect(corrupt.files[0].actions).toEqual([]);
    expect(hydrate).toHaveBeenCalledTimes(2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('checks Git status paths concurrently with a bounded pool and stable ordering', async () => {
  const root = await temporary();
  try {
    await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    const names = Array.from({ length: 32 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), 'text')));
    await fs.writeFile(path.join(root, '.env.local'), 'private');
    const original = fs.lstat.bind(fs); let active = 0, peak = 0;
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      peak = Math.max(peak, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await original(...args); }
      finally { active--; }
    }) as typeof fs.lstat);
    const started = performance.now();
    const status = await dispatch('gitManage', { operation: 'status', root }, [root]) as ManagementStatus;
    console.log(`PERF git-status=32 paths elapsed=${(performance.now() - started).toFixed(1)}ms peak-checks=${peak}`);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
    expect(status.entries.filter(entry => !entry.blocked).map(entry => entry.path)).toEqual(names);
    expect(status.entries.find(entry => entry.path === '.env.local')?.blocked).toBeTruthy();
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});

it('built backend serves bootstrap and comments while a Git request is stalled', async () => {
  const directory = await temporary(), previousPi = (globalThis as any).pi;
  const root = path.join(directory, 'project'), data = path.join(directory, 'data'), entry = path.join(directory, 'main.cjs');
  let plugin: any, loaded = false, release: (() => void) | undefined, pending: Promise<unknown> | undefined;
  try {
    await fs.mkdir(root); await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    const workspace = vi.fn(async () => ({ path: root }));
    (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: workspace }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    workspace.mockImplementationOnce(() => new Promise(resolve => release = () => resolve({ path: root })));
    pending = plugin.onRendererCall('gitManage', { operation: 'status', root });
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeTypeOf('function');
    const quick = Promise.all([plugin.onRendererCall('bootstrap', {}), plugin.onRendererCall('comments', {})]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([quick.then(() => true), new Promise<boolean>(resolve => timer = setTimeout(() => resolve(false), 1000))]);
      expect(completed).toBe(true);
    } finally { if (timer) clearTimeout(timer); release!(); await Promise.all([pending, quick]); }
    expect(await pending).toMatchObject({ root });
  } finally {
    release?.(); if (pending) await pending.catch(() => {});
    if (loaded) await plugin.onUnload();
    (globalThis as any).pi = previousPi; vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true });
  }
});
