import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { beginCaptureLease, endCaptureLease, inspectCaptureLeases } from '../../src/core/capture-leases';
import { publicDesktopFixture } from '../helpers/public-desktop-fixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture() {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'maintenance-main-'));
  const root = path.join(temp, 'project'), other = path.join(temp, 'other'), data = path.join(temp, 'data');
  await fs.mkdir(root); await fs.mkdir(other);
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const previous = (globalThis as any).pi;
  vi.spyOn(os, 'homedir').mockReturnValue(temp);
  const workspace = { current: { path: root } as { path: string } | null };
  (globalThis as any).pi = { desktop: publicDesktopFixture({}), plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => workspace.current }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); await plugin.onLoad();
  cleanups.push(async () => { await plugin.onUnload(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); });
  const store = new SnapshotStore(data), call = (args: any) => plugin.onRendererCall('captureMaintenance', args);
  const legacy = await beginCaptureLease(store, root, 'old');
  const otherLegacy = await beginCaptureLease(store, other, 'other');
  const active = await beginCaptureLease(store, root, 'modern', [path.join(root, 'active.txt')], { sessionId: 's', toolCallId: 'call', executionId: 'execution' });
  const partialModern = await beginCaptureLease(store, root, 'partial-modern', [path.join(root, 'partial.txt')], { executionId: 'execution-only' });
  return { root, other, data, store, call, plugin, workspace, legacy, otherLegacy, active, partialModern };
}
it('inspects through the background bridge, backs up exact legacy IDs and preserves other/modern writers', async () => {
  const f = await fixture();
  const job = await f.plugin.onRendererCall('jobStart', { method: 'captureMaintenance', args: { action: 'inspect', root: f.root }, waitMs: 1000 });
  expect(job.state).toBe('done');
  const view = job.result;
  expect(view).toMatchObject({ root: f.root, count: 1, ids: [f.legacy] });
  const before = await inspectCaptureLeases(f.store);
  expect(await f.call({ action: 'retire', root: f.root, ids: view.ids, fingerprint: view.fingerprint, writersStopped: true })).toMatchObject({ ok: true, count: 1 });
  const after = await inspectCaptureLeases(f.store);
  expect(after.leases).toEqual(before.leases.filter(lease => lease.id !== f.legacy));
  const backup = JSON.parse(await fs.readFile(path.join(f.data, 'backups', `leases-${view.fingerprint}.json`), 'utf8'));
  expect(backup.leases).toEqual(before.leases);
  const fresh = await beginCaptureLease(f.store, f.root, 'fresh', [path.join(f.root, 'fresh.txt')]);
  expect(await endCaptureLease(f.store, fresh)).toBe(false);
});
it('does not write on inspection/cancel and rejects missing confirmation, forged or duplicate IDs', async () => {
  const f = await fixture(), before = await inspectCaptureLeases(f.store);
  const view = await f.call({ action: 'inspect', root: f.root });
  expect((await inspectCaptureLeases(f.store)).fingerprint).toBe(before.fingerprint);
  const args = { action: 'retire', root: f.root, ids: view.ids, fingerprint: view.fingerprint };
  await expect(f.call(args)).rejects.toThrow(/confirmation/);
  await expect(f.call({ ...args, writersStopped: false })).rejects.toThrow(/confirmation/);
  for (const ids of [[f.active], [f.partialModern], [f.otherLegacy], [f.legacy, f.legacy], ['unknown-id']]) await expect(f.call({ ...args, ids, writersStopped: true })).rejects.toThrow();
  expect((await inspectCaptureLeases(f.store)).fingerprint).toBe(before.fingerprint);
  expect(await fs.readdir(path.join(f.data, 'backups'))).toHaveLength(0);
});
it('rejects stale fingerprints and rechecks workspace authorization at retirement', async () => {
  const f = await fixture(), view = await f.call({ action: 'inspect', root: f.root });
  await beginCaptureLease(f.store, f.other, 'new-other');
  const args = { action: 'retire', root: f.root, ids: view.ids, fingerprint: view.fingerprint, writersStopped: true };
  await expect(f.call(args)).rejects.toThrow(/changed/);
  await expect(f.call({ action: 'inspect', root: f.other })).rejects.toThrow(/authorized/);
  f.workspace.current = null;
  await expect(f.call(args)).rejects.toThrow(/authorized/);
  expect((await inspectCaptureLeases(f.store)).leases.some(lease => lease.id === f.legacy)).toBe(true);
});
