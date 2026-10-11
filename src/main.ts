import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SnapshotStore, atomicJson, locatorPath, readJson, type Locator } from './core/storage';
import { ReviewService } from './core/review-service';
import { fail } from './core/path-policy';
import { JobQueue } from './core/jobs';
import { inspectNativeHostBuild } from './core/native-host-build';
import { ReviewNavigationStore } from './core/review-navigation';
declare const pi: any;
let service: ReviewService | null = null, store: SnapshotStore | null = null;
let jobs: JobQueue | null = null;
let locatorFile = '', generation = '', pluginRoot = '';
let timer: ReturnType<typeof setInterval> | undefined;
let turnEnded: ((event: { sessionId?: string; turnId?: string; reason?: string }) => void) | undefined;
let tail: Promise<unknown> = Promise.resolve();
let disposed = false;
let rendererStages: Record<string, number> = {};
const navigation = new ReviewNavigationStore();
function serial<T>(work: () => Promise<T>): Promise<T> { const result = tail.then(work); tail = result.catch(() => {}); return result; }
async function heartbeat(): Promise<void> {
  if (disposed || !store) return;
  await atomicJson(locatorFile, { version: 1, pluginRoot, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 } satisfies Locator);
}
export async function onLoad(): Promise<void> {
  disposed = false; generation = randomUUID(); pluginRoot = await fs.realpath(__dirname);
  const dataPath = await pi.plugin.getDataPath(); store = new SnapshotStore(dataPath); await store.init();
  rendererStages = {}; navigation.clear();
  await atomicJson(path.join(store.directory, 'renderer-status.json'), { version: 1, generation, mainLoadedAt: Date.now(), stages: rendererStages });
  locatorFile = await locatorPath(pluginRoot); await heartbeat();
  service = new ReviewService(store, { workspace: () => pi.workspace.get(), settings: () => pi.plugin.getSettings(), setSettings: v => pi.plugin.setSettings(v), appearance: () => pi.app.getAppearance(), clipboard: text => pi.clipboard.writeText(text), openPanel: () => pi.ui.openPanel({ title: 'Diff view' }) }, generation);
  const currentService = service;
  jobs = new JobQueue((method, args) => serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Plugin unloaded'); return execute(currentService, method, args ?? {}); }));
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
  jobs?.close(); jobs = null; navigation.clear();
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
  if (method === 'activeReviewSession' || method === 'readTurnSelection') return execute(service, method, args ?? {}); // Volatile UI state must not queue behind long Git jobs.
  if (method === 'nativeProbeInfo') return serial(async () => inspectNativeHostBuild(String(await pi.app.getVersion())));
  if (method === 'rendererReport') {
    const stage = (args as { stage?: unknown } | null)?.stage;
    if (typeof stage !== 'string' || !['entry-loaded', 'reply-slot-mounted', 'card-bound', 'session-ready', 'session-source-error', 'sidebar-opened', 'view-targeted', 'bootstrap-ok', 'bootstrap-error', 'card-query-error'].includes(stage)) fail('INVALID_STAGE', 'Unknown renderer diagnostic stage');
    return serial(async () => { if (disposed || !store) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); rendererStages[stage] = Date.now(); await atomicJson(path.join(store.directory, 'renderer-status.json'), { version: 1, generation, stages: rendererStages }); return { ok: true }; });
  }
  if (method === 'jobStart') { const a = args as { method: string; args?: unknown }; return jobs!.start(a.method, a.args ?? {}); }
  if (method === 'jobPoll') return jobs!.poll((args as { jobId: string }).jobId);
  const s = service;
  return serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args ?? {}); });
}
async function execute(s: ReviewService, method: string, args: any): Promise<unknown> {
  if (method === 'activeReviewSession') {
    if (args?.sessionId !== null && (typeof args?.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 256 || /[\0\r\n]/.test(args.sessionId))) fail('NAVIGATION_INVALID', 'Invalid renderer session');
    navigation.setActiveSession(args.sessionId); return { ok: true };
  }
  if (method === 'selectTurn') {
    if (typeof args?.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 128 || typeof args?.runId !== 'string' || !args.runId || args.runId.length > 128 || (args.fileId != null && (typeof args.fileId !== 'string' || args.fileId.length > 256))) fail('NAVIGATION_INVALID', 'Invalid recorded-task target');
    let page = await s.turnSummary({ sessionId: args.sessionId, runId: args.runId, limit: 100 });
    if (args.fileId) {
      while (!page.files.some(file => file.id === args.fileId) && page.nextOffset != null) page = await s.turnSummary({ sessionId: args.sessionId, runId: args.runId, offset: page.nextOffset, limit: 100 });
      if (!page.files.some(file => file.id === args.fileId)) fail('FILE_MISSING', 'Recorded file no longer available; refresh');
    }
    const run = await store!.getRun(args.runId, false, false);
    if (!run || run.sessionId !== args.sessionId) fail('RUN_MISSING', 'Recorded task is unavailable');
    return navigation.set({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root: run.root }, args.fileId);
  }
  if (method === 'readTurnSelection') {
    if (typeof args?.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.nonce)) fail('NAVIGATION_INVALID', 'Invalid selection token');
    const selection = navigation.get(args.nonce);
    if (!selection) fail('NAVIGATION_EXPIRED', '选择已过期，请重新点击文末文件 / Selection expired; click the reply card again');
    return selection;
  }
  if (method === 'clearHistory') navigation.clear();
  return s.invoke(method, args);
}
