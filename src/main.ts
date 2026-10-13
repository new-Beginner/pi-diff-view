import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SnapshotStore, atomicJson, locatorPath, readJson, type Locator } from './core/storage';
import { ReviewService } from './core/review-service';
import { fail } from './core/path-policy';
import { JobQueue } from './core/jobs';
import { inspectNativeHostBuild } from './core/native-host-build';
import { ReviewNavigationStore } from './core/review-navigation';
import { HostHistoryImporter } from './core/host-history';
import { HostEvidenceStore } from './core/host-evidence-store';
let evidenceStore: HostEvidenceStore | null = null;
import { dispatch as gitManageDispatch } from './git/local-management';
import { canonical } from './core/path-policy';
import { writeCaptureContexts, type CaptureContext } from './core/capture-context';
import { HostEvidenceBuffer } from './core/host-evidence-buffer';
import { FileOpenRequests } from './core/file-open';
const fileOpens = new FileOpenRequests();
const evidence = new HostEvidenceBuffer();
let history: HostHistoryImporter | null = null;
const contexts = new Map<string, CaptureContext & { syncedAt: number }>();
declare const pi: any;
let service: ReviewService | null = null, store: SnapshotStore | null = null;
let jobs: JobQueue | null = null;
let locatorFile = '', generation = '', pluginRoot = '';
let timer: ReturnType<typeof setInterval> | undefined;
let turnEnded: ((event: { sessionId?: string; turnId?: string; reason?: string }) => void) | undefined;
let tail: Promise<unknown> = Promise.resolve();
let navigationTail: Promise<unknown> = Promise.resolve();
let navigationVersion = 0;
let navigationClearing = false;
let disposed = false;
let rendererStages: Record<string, number> = {};
let runningDiagnostic: { sessionId: string; reason: string; at: number } | undefined;
let rendererDiagnostic: { stage: string; at: number } | undefined;
async function saveRendererStatus(): Promise<void> {
  if (store && !disposed) await atomicJson(path.join(store.directory, 'renderer-status.json'), { version: 1, generation, stages: rendererStages, rendererDiagnostic, runningDiagnostic });
}
const navigation = new ReviewNavigationStore();
function serial<T>(work: () => Promise<T>): Promise<T> { const result = tail.then(work); tail = result.catch(() => {}); return result; }
async function heartbeat(): Promise<void> {
  if (disposed || !store) return;
  await atomicJson(locatorFile, { version: 1, pluginRoot, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 } satisfies Locator);
}
export async function onLoad(): Promise<void> {
  disposed = false; generation = randomUUID(); pluginRoot = await fs.realpath(__dirname);
  const dataPath = await pi.plugin.getDataPath(); store = new SnapshotStore(dataPath); await store.init();
  evidenceStore = new HostEvidenceStore(dataPath);
  // Native getDataPath contract: <host-data>/plugins/data/<plugin-id>.
  const parent = path.dirname(dataPath), plugins = path.dirname(parent);
  history = path.basename(parent) === 'data' && path.basename(plugins) === 'plugins' ? new HostHistoryImporter(store, path.dirname(plugins)) : null;
  contexts.clear(); evidence.clear();
  fileOpens.clear();
  rendererStages = {}; runningDiagnostic = undefined; rendererDiagnostic = undefined; navigation.clear();
  navigation.restore(await readJson(path.join(store.directory, 'selections.json'), []));
  await saveRendererStatus();
  await writeCaptureContexts(store.directory, generation, []);
  locatorFile = await locatorPath(pluginRoot); await heartbeat();
  service = new ReviewService(store, { workspace: () => pi.workspace.get(), settings: () => pi.plugin.getSettings(), setSettings: v => pi.plugin.setSettings(v), appearance: () => pi.app.getAppearance(), clipboard: text => pi.clipboard.writeText(text), openPanel: () => pi.ui.openPanel({ title: 'Diff view' }) }, generation);
  const currentService = service;
  jobs = new JobQueue((method, args) => method === 'selectTurn' ? dispatch(method, args) : serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Plugin unloaded'); return execute(currentService, method, args ?? {}); }));
  await store.importInbox(generation); await store.prune();
  await pi.commands.register({ id: 'diff-view.open', title: 'Diff view: Open review', keywords: ['diff', 'review', '审查', '变更'], run: () => pi.ui.openPanel({ title: 'Diff view' }) });
  turnEnded = event => { void serial(async () => {
    if (disposed || !store || !event.sessionId) return;
    await store.importInbox(generation);
    const context = contexts.get(event.sessionId);
    if (history && context && service) {
      // Re-read actual final message evidence; do not bind the event's internal turnId.
      const result = await history.syncSession(event.sessionId, context.root, { ...context, messages: evidence.messages(event.sessionId, canonical(context.root)) });
      service.setRecoveryNotice(event.sessionId, result.warnings.join(' '));
      context.syncedAt = 0; // The renderer's settled state may arrive immediately afterwards.
    }
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
  fileOpens.clear();
  await tail;
  await navigationTail;
  evidence.clear(); contexts.clear();
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
  if (method === 'selectTurn') {
    if (navigationClearing) fail('SELECTION_MISSING', 'History is being cleared');
    const s = service;
    const result = navigationTail.catch(() => {}).then(async () => { if (disposed || service !== s) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args ?? {}); });
    navigationTail = result.catch(() => {}); return result;
  }
  if (method === 'activeReviewSession' || method === 'readTurnSelection' || method === 'openFile') return execute(service, method, args ?? {}); // Volatile UI state must not queue behind long Git jobs.
  if (method === 'nativeProbeInfo') return serial(async () => inspectNativeHostBuild(String(await pi.app.getVersion())));
  if (method === 'rendererReport') {
    const stage = (args as { stage?: unknown } | null)?.stage;
    if (typeof stage !== 'string' || !/^(entry-loaded|reply-slot-mounted|card-bound|session-ready|session-source-error|sidebar-opened|view-targeted|bootstrap-ok|bootstrap-error|card-query-error|composer-mounted|composer-source-error|composer-layer-error|composer-anchor-missing|composer-anchor-offscreen|composer-positioned|running-idle|running-identity-missing|running-ready|running-query-empty|running-query-error|running-visible|running-click-error)$/.test(stage)) fail('INVALID_STAGE', 'Unknown renderer diagnostic stage');
    return serial(async () => { if (disposed || !store) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); rendererStages[stage] = Date.now(); rendererDiagnostic = { stage, at: Date.now() }; await saveRendererStatus(); return { ok: true }; });
  }
  if (method === 'jobStart') {
    const a = args as { method: string; args?: unknown; waitMs?: number }, currentJobs = jobs!;
    const started = currentJobs.start(a.method, a.args ?? {});
    if (!Number.isFinite(a.waitMs) || !a.waitMs || a.waitMs < 0) return started;
    const result = await currentJobs.wait(started.jobId, a.waitMs);
    return result.state === 'pending' ? started : { ...started, ...result };
  }
  if (method === 'jobPoll') return jobs!.poll((args as { jobId: string }).jobId);
  const s = service;
  return serial(async () => { if (disposed) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args ?? {}); });
}
/** Recording scope is not mutation authorization: workspace roots stay owned by ReviewService. */
async function sessionRoot(args: any): Promise<string | undefined> {
  if (typeof args?.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId)) fail('SESSION_REQUIRED', 'Invalid session identity');
  const workspace = await pi.workspace.get();
  const roots: string[] = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
  if (roots.length) return typeof args.root === 'string' && roots.some(r => canonical(r) === canonical(args.root)) ? args.root : undefined;
  // Native host owns this exact session leaf. Never grant an arbitrary renderer-supplied root.
  return history?.scratchRoot(args.sessionId);
}
async function execute(s: ReviewService, method: string, args: any): Promise<unknown> {
  if (method === 'openFile') {
    if (args.listen === true) return fileOpens.listen(args.sessionId, args.listenerId);
    if (typeof args.cancelListen === 'string') return fileOpens.cancelListen(args.sessionId, args.cancelListen);
    if (typeof args.requestId === 'string') {
      if (args.complete === true) return fileOpens.complete(args.requestId, args.sessionId, typeof args.error === 'string' ? args.error : undefined);
      return args.wait === true ? fileOpens.waitStatus(args.requestId) : fileOpens.status(args.requestId);
    }
    const target = await s.fileOpenTarget(args);
    if (disposed || service !== s) fail('PLUGIN_UNLOADED', 'Diff view unloaded');
    return fileOpens.add(target);
  }
  if (method === 'sessionEvidence') {
    const root = await sessionRoot(args);
    if (!root) fail('ROOT_DENIED', 'Unauthorized evidence project');
    if (args.index === 0) await evidenceStore!.restore(evidence, args.sessionId, root);
    evidence.append({ ...args, root: canonical(root) });
    if (args.final === true) await evidenceStore!.save(evidence, args.sessionId, root);
    return { ok: true };
  }
  if (method === 'gitManage') {
    const workspace = await pi.workspace.get();
    const roots = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
    return gitManageDispatch(method, args, roots);
  }
  if (method === 'sessionContext') {
    const root = await sessionRoot(args);
    if (!root) { const warning = '会话项目路径缺失或未授权，未导入历史。'; contexts.delete(args.sessionId); await writeCaptureContexts(store!.directory, generation, [...contexts.values()]); s.setRecoveryNotice(args.sessionId, warning); return { ok: false, warning }; }
    const now = Date.now();
    const taskId = typeof args.taskId === 'string' && /^[a-zA-Z0-9-]{1,256}$/.test(args.taskId) ? args.taskId : undefined;
    const since = Number.isSafeInteger(args.since) && args.since > 0 && args.since <= now ? args.since : undefined;
    contexts.delete(args.sessionId);
    contexts.set(args.sessionId, { sessionId: args.sessionId, root, running: args.running === true, taskId, since, syncedAt: now, updatedAt: now });
    while (contexts.size > 200) contexts.delete(contexts.keys().next().value!);
    await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
    await evidenceStore!.restore(evidence, args.sessionId, root);
    if (!history) { const warning = '宿主历史路径契约不匹配，未导入历史。'; s.setRecoveryNotice(args.sessionId, warning); return { ok: false, warning }; }
    const result = await history.syncSession(args.sessionId, root, { ...contexts.get(args.sessionId)!, messages: evidence.messages(args.sessionId, canonical(root)) });
    s.setRecoveryNotice(args.sessionId, result.warnings.join(' ')); return result;
  }
  const context = typeof args?.sessionId === 'string' ? contexts.get(args.sessionId) : undefined;
  const preparedReview = method === 'review' && history && context && (args.scope === 'turn' || args.scope === 'lastTurn');
  if (preparedReview) await store!.importInbox(generation);
  if (history && context && ['runningChanges', 'replyCards', 'bootstrap', 'review', 'turnSummary'].includes(method) && (store!.needsRecovery(args.sessionId) || Date.now() - context.syncedAt > 2000)) {
    const result = await history.syncSession(args.sessionId, context.root, { ...context, messages: evidence.messages(args.sessionId, canonical(context.root)) });
    context.syncedAt = Date.now(); store!.acknowledgeRecovery(args.sessionId);
    s.setRecoveryNotice(args.sessionId, result.warnings.join(' '));
  }
  if (method === 'review' && (args.scope === 'turn' || args.scope === 'lastTurn')) return s.review(args, Boolean(preparedReview), context);
  if (method === 'runningChanges') {
    if (context?.running && context.taskId === args.taskId && context.since === args.since) {
      context.updatedAt = Date.now(); await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
    }
    const result = await s.runningChanges(args);
    let reason = 'summary-available';
    if (!result) {
      const runs = (await store!.listRuns(false, true)).filter(r => r.sessionId === args.sessionId);
      const run = (args.taskId ? runs.find(r => r.userMessageId === args.taskId) : undefined) ?? runs.find(r => args.since > 0 && r.startedAt >= args.since);
      reason = !run ? 'capture-missing-or-task-mismatch' : run.boundary !== 'user' ? 'capture-boundary-unknown' : run.state !== 'running' || run.endedAt != null ? 'capture-settled' : run.generation !== generation && run.source !== 'host-history' && !run.hostRecovery ? 'capture-generation-mismatch' : Object.values(run.changes).some(c => c.ambiguous) ? 'capture-ownership-unknown' : run.fileCount === 0 ? 'no-net-changes' : 'no-verified-running-record';
    }
    if (runningDiagnostic?.reason !== reason || runningDiagnostic.sessionId !== args.sessionId) {
      runningDiagnostic = { sessionId: args.sessionId, reason, at: Date.now() }; await saveRendererStatus();
    }
    return result;
  }
  if (method === 'activeReviewSession') {
    if (args?.sessionId !== null && (typeof args?.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 256 || /[\0\r\n]/.test(args.sessionId))) fail('NAVIGATION_INVALID', 'Invalid renderer session');
    navigation.setActiveSession(args.sessionId); return { ok: true };
  }
  if (method === 'selectTurn') {
    if (typeof args?.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 128 || typeof args?.runId !== 'string' || !args.runId || args.runId.length > 128 || (args.fileId != null && (typeof args.fileId !== 'string' || args.fileId.length > 256))) fail('NAVIGATION_INVALID', 'Invalid recorded-task target');
    const version = navigationVersion;
    const run = await s.selectTarget(args);
    if (!run) fail('RUN_MISSING', 'Recorded task not found in this session');
    if (disposed || service !== s || version !== navigationVersion) fail('SELECTION_MISSING', 'Selection cleared or plugin unloaded');
    const selection = navigation.set({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root: run.root }, args.fileId);
    await atomicJson(path.join(store!.directory, 'selections.json'), navigation.export());
    return selection;
  }
  if (method === 'readTurnSelection') {
    if (typeof args?.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.nonce)) fail('NAVIGATION_INVALID', 'Invalid selection token');
    if (typeof args?.sessionId !== 'string' || !args.sessionId) fail('SESSION_REQUIRED', '当前视图缺少会话标识；请从本会话重新打开差异审查。');
    const selection = navigation.get(args.nonce, args.sessionId);
    if (!selection) fail('SELECTION_MISSING', '本会话的文件选择不存在或已清除；可返回本会话修改记录重新选择。');
    await s.selectTarget({ runId: selection.request.runId!, sessionId: args.sessionId });
    return selection;
  }
  if (method === 'clearHistory' && args?.confirmed === true) {
    navigationClearing = true; navigationVersion++;
    try { await navigationTail; const result = await s.invoke(method, args); evidence.clear(); navigation.clear(); fileOpens.clear(); await atomicJson(path.join(store!.directory, 'selections.json'), []); return result; }
    finally { navigationClearing = false; }
  }
  return s.invoke(method, args);
}
