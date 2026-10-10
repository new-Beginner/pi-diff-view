import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SnapshotStore, atomicJson, locatorPath, readJson, type Locator } from './core/storage';
import { ReviewService } from './core/review-service';
import { fail } from './core/path-policy';
import { JobQueue } from './core/jobs';
import { inspectNativeHostBuild } from './core/native-host-build';
declare const pi: any;
let service: ReviewService | null = null, store: SnapshotStore | null = null;
let jobs: JobQueue | null = null;
let locatorFile = '', generation = '', pluginRoot = '';
let timer: ReturnType<typeof setInterval> | undefined;
let turnEnded: ((event: { sessionId?: string; turnId?: string; reason?: string }) => void) | undefined;
let tail: Promise<unknown> = Promise.resolve();
let disposed = false;
function serial<T>(work: () => Promise<T>): Promise<T> { const result = tail.then(work); tail = result.catch(() => {}); return result; }
async function heartbeat(): Promise<void> {
  if (disposed || !store) return;
  await atomicJson(locatorFile, { version: 1, pluginRoot, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 } satisfies Locator);
}
export async function onLoad(): Promise<void> {
  disposed = false; generation = randomUUID(); pluginRoot = await fs.realpath(__dirname);
  const dataPath = await pi.plugin.getDataPath(); store = new SnapshotStore(dataPath); await store.init();
  locatorFile = await locatorPath(pluginRoot); await heartbeat();
  service = new ReviewService(store, { workspace: () => pi.workspace.get(), settings: () => pi.plugin.getSettings(), setSettings: v => pi.plugin.setSettings(v), appearance: () => pi.app.getAppearance(), clipboard: text => pi.clipboard.writeText(text), openPanel: () => pi.ui.openPanel({ title: 'Diff view' }) }, generation);
  const currentService = service;
  jobs = new JobQueue((method, args) => serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Plugin unloaded'); return currentService.invoke(method, args ?? {}); }));
  await store.importInbox(generation); await store.prune();
  await pi.commands.register({ id: 'diff-view.open', title: 'Diff view: Open review', keywords: ['diff', 'review', '审查', '变更'], run: () => pi.ui.openPanel({ title: 'Diff view' }) });
  turnEnded = event => { void serial(async () => {
    if (disposed || !store || !event.sessionId) return;
    await store.importInbox(generation);
    // The event has no captureRunId/timestamp: retain audit evidence, never guess a binding.
    await store.audit({ action: 'host-turn-ended', sessionId: String(event.sessionId).slice(0, 128), turnId: String(event.turnId ?? '').slice(0, 128), reason: String(event.reason ?? '').slice(0, 128) });
  }).catch(error => console.warn('Diff view turn import:', error.message)); };
  pi.events.on('session:turnEnded', turnEnded);
  timer = setInterval(() => { void serial(async () => { if (!disposed) { await heartbeat(); await store?.importInbox(generation); await store?.prune(); } }).catch(error => console.warn('Diff view capture import:', error.message)); }, 2000);
  timer.unref?.();
}
export async function onUnload(): Promise<void> {
  disposed = true; if (timer) clearInterval(timer); timer = undefined;
  if (turnEnded) pi.events.off('session:turnEnded', turnEnded); turnEnded = undefined;
  jobs?.close(); jobs = null;
  await tail;
  const current = await readJson<Locator | null>(locatorFile, null).catch(() => null);
  if (current?.generation === generation) await fs.rm(locatorFile, { force: true });
  await pi.commands.unregister('diff-view.open'); service = null; store = null;
}
export async function onPanelInvoke(channel: string, payload: unknown): Promise<unknown> {
  if (!channel.startsWith('diff.')) fail('UNKNOWN_METHOD', 'Unknown Diff view channel');
  return dispatch(channel.slice(5), payload);
}
export async function onRendererCall(method: string, args: unknown): Promise<unknown> { return dispatch(method.startsWith('diff.') ? method.slice(5) : method, args); }
async function dispatch(method: string, args: unknown): Promise<unknown> {
  if (!service || disposed) fail('PLUGIN_UNLOADED', 'Diff view is not loaded');
  if (method === 'nativeProbeInfo') return serial(async () => inspectNativeHostBuild(String(await pi.app.getVersion())));
  if (method === 'jobStart') { const a = args as { method: string; args?: unknown }; return jobs!.start(a.method, a.args ?? {}); }
  if (method === 'jobPoll') return jobs!.poll((args as { jobId: string }).jobId);
  const s = service;
  return serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return s.invoke(method, args ?? {}); });
}
