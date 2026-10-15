import { ReadWriteQueue } from './core/read-write-queue';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewRequest, ReviewSummary } from './core/contracts';
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
import { CAPTURE_CONTEXT_TTL, writeCaptureContexts, type CaptureContext } from './core/capture-context';
import { HostEvidenceBuffer } from './core/host-evidence-buffer';
import { FileOpenRequests } from './core/file-open';
import { openSystemFile } from './core/system-open';
let systemOpenController = new AbortController();
const fileOpens = new FileOpenRequests();
const evidence = new HostEvidenceBuffer();
let history: HostHistoryImporter | null = null;
type SessionContext = CaptureContext & { syncedAt: number; prepared?: boolean };
const contexts = new Map<string, SessionContext>();
// Generation-local and bounded: never wait here for renderer work queued behind review.
const reviewPreparations = new Map<string, { startedAt: number; attemptedAt: number; prepared: boolean }>();
const sessionRoots = new Map<string, string>();
const freshHistoryContext = (context: CaptureContext) => ({ ...context, statusKnown: context.statusKnown !== false && Date.now() - context.updatedAt <= CAPTURE_CONTEXT_TTL, messages: evidence.messages(context.sessionId, canonical(context.root)) });
declare const pi: any;
let service: ReviewService | null = null, store: SnapshotStore | null = null;
const repositoryQueue = new ReadWriteQueue(4);
const repositoryTasks = new Set<Promise<unknown>>();
const managementReads = new Set(['status', 'branches', 'history', 'stashList', 'diff', 'stats', 'commitDiff', 'blame', 'stashShow', 'discardPreview']);
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
function schedule(s: ReviewService, method: string, args: any): Promise<unknown> {
  const work = async () => { if (disposed || service !== s) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args); };
  if (method === 'openSystemFile') return work();
  if (method === 'gitManage') {
    const result = repositoryQueue.run(work, !managementReads.has(args?.operation));
    repositoryTasks.add(result);
    void result.then(() => repositoryTasks.delete(result), () => repositoryTasks.delete(result));
    return result;
  }
  if (method === 'action' || method === 'batchAction' || (method === 'review' && !['turn', 'lastTurn'].includes(args?.scope))) {
    // Reserve the history queue position now, but enter only after the repository fence.
    // Git management does not occupy the history queue, so long hooks cannot block cards/comments.
    let release!: () => void;
    const admitted = new Promise<void>(resolve => release = resolve);
    const queued = serial(async () => { await admitted; return work(); });
    return repositoryQueue.run(async () => { release(); return queued; }, method !== 'review');
  }
  return serial(work);
}
async function heartbeat(): Promise<void> {
  if (disposed || !store) return;
  await atomicJson(locatorFile, { version: 1, pluginRoot, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 } satisfies Locator);
}
export async function onLoad(): Promise<void> {
  disposed = false; generation = randomUUID(); pluginRoot = await fs.realpath(__dirname);
  systemOpenController = new AbortController();
  const dataPath = await pi.plugin.getDataPath(); store = new SnapshotStore(dataPath); await store.init();
  evidenceStore = new HostEvidenceStore(dataPath);
  // Native getDataPath contract: <host-data>/plugins/data/<plugin-id>.
  const parent = path.dirname(dataPath), plugins = path.dirname(parent);
  history = path.basename(parent) === 'data' && path.basename(plugins) === 'plugins' ? new HostHistoryImporter(store, path.dirname(plugins)) : null;
  contexts.clear(); evidence.clear(); reviewPreparations.clear();
  sessionRoots.clear();
  const savedRoots = await readJson<Record<string, string>>(path.join(store.directory, 'session-roots.json'), {});
  for (const [id, root] of Object.entries(savedRoots).slice(-200)) if (/^[a-zA-Z0-9-]{1,80}$/.test(id) && typeof root === 'string' && path.isAbsolute(root)) sessionRoots.set(id, root);
  fileOpens.clear();
  rendererStages = {}; runningDiagnostic = undefined; rendererDiagnostic = undefined; navigation.clear();
  navigation.restore(await readJson(path.join(store.directory, 'selections.json'), []));
  await saveRendererStatus();
  await writeCaptureContexts(store.directory, generation, []);
  locatorFile = await locatorPath(pluginRoot); await heartbeat();
  service = new ReviewService(store, { workspace: () => pi.workspace.get(), settings: () => pi.plugin.getSettings(), setSettings: v => pi.plugin.setSettings(v), appearance: () => pi.app.getAppearance(), clipboard: text => pi.clipboard.writeText(text), openPanel: () => pi.ui.openPanel({ title: 'Diff view' }) }, generation);
  const currentService = service;
  jobs = new JobQueue((method, args) => method === 'selectTurn' ? dispatch(method, args) : schedule(currentService, method, args ?? {}));
  await store.importInbox(generation); await store.prune();
  await pi.commands.register({ id: 'diff-view.open', title: 'Diff view: Open review', keywords: ['diff', 'review', '审查', '变更'], run: () => pi.ui.openPanel({ title: 'Diff view' }) });
  turnEnded = event => { void serial(async () => {
    if (disposed || !store || !event.sessionId) return;
    await store.importInbox(generation);
    const context = contexts.get(event.sessionId);
    if (history && context && service) {
      // Re-read actual final message evidence; do not bind the event's internal turnId.
      await history.syncSession(event.sessionId, context.root, freshHistoryContext(context));
      context.syncedAt = 0; // The renderer's settled state may arrive immediately afterwards.
    }
    // The event has no captureRunId/timestamp: retain audit evidence, never guess a binding.
    await store.audit({ action: 'host-turn-ended', sessionId: String(event.sessionId).slice(0, 128), turnId: String(event.turnId ?? '').slice(0, 128), reason: String(event.reason ?? '').slice(0, 128) });
  }).catch(error => console.warn('Diff view turn import:', error.message)); };
  pi.events.on('session:turnEnded', turnEnded);
  let maintenancePending = false;
  timer = setInterval(() => {
    if (disposed || maintenancePending) return;
    maintenancePending = true;
    void serial(async () => { if (!disposed) { await heartbeat(); await store?.importInbox(generation); await store?.prune(); } })
      .catch(error => console.warn('Diff view capture import:', error.message)).finally(() => { maintenancePending = false; });
  }, 2000);
  timer.unref?.();
}
export async function onUnload(): Promise<void> {
  disposed = true; if (timer) clearInterval(timer); timer = undefined;
  systemOpenController.abort();
  if (turnEnded) pi.events.off('session:turnEnded', turnEnded); turnEnded = undefined;
  jobs?.close(); jobs = null; navigation.clear();
  fileOpens.clear();
  await tail;
  await navigationTail;
  await Promise.allSettled([...repositoryTasks]);
  evidence.clear(); contexts.clear(); reviewPreparations.clear();
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
  if (method === 'activeReviewSession' || method === 'readTurnSelection' || method === 'openFile' || method === 'openSystemFile') return execute(service, method, args ?? {}); // Volatile UI state must not queue behind long Git jobs.
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
  return schedule(service, method, args ?? {});
}
/** Recording scope is not mutation authorization: workspace roots stay owned by ReviewService. */
async function sessionRoot(args: any): Promise<string | undefined> {
  if (typeof args?.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId)) fail('SESSION_REQUIRED', 'Invalid session identity');
  const workspace = await pi.workspace.get();
  const roots: string[] = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
  if (roots.length && typeof args.root === 'string' && roots.some(r => canonical(r) === canonical(args.root))) return args.root;
  const retained = sessionRoots.get(args.sessionId) ?? contexts.get(args.sessionId)?.root;
  if (retained && (canonical(retained) === canonical(history?.scratchRoot(args.sessionId) ?? '') || !args.root || canonical(args.root) === canonical(retained))) return retained;
  if (roots.length || (typeof args.root === 'string' && history && canonical(args.root) !== canonical(history.scratchRoot(args.sessionId)))) return undefined;
  if (history && store && (await store.listRuns(false, true)).some(r => r.sessionId === args.sessionId && canonical(r.root) !== canonical(history!.scratchRoot(args.sessionId)))) return undefined;
  // Only genuinely rootless sessions may use the host-owned scratch leaf.
  return history?.scratchRoot(args.sessionId);
}
async function recordedReview(s: ReviewService, args: ReviewRequest, context?: SessionContext): Promise<ReviewSummary> {
  if (!history) return s.review(args);
  if (typeof args.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId)) fail('SESSION_REQUIRED', 'Invalid session identity');
  if (args.scope === 'turn' && (typeof args.runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.runId))) fail('INVALID_ID', 'A valid runId is required');
  await store!.importInbox(generation);
  const recorded = args.runId ? await store!.getRun(args.runId, false, false) : (await store!.listRuns(false, true)).find(run => run.sessionId === args.sessionId && (!args.root || canonical(run.root) === canonical(args.root)));
  const owned = recorded?.sessionId === args.sessionId ? recorded : undefined;
  const candidate = args.root ?? context?.root ?? sessionRoots.get(args.sessionId) ?? owned?.root;
  // Exact stored session ownership grants historical reads only, never disk mutation rights.
  const root = await sessionRoot({ sessionId: args.sessionId, root: candidate }) ?? (owned && candidate && canonical(owned.root) === canonical(candidate) ? owned.root : undefined);
  if (!root && args.root) fail('ROOT_DENIED', 'Recorded project is not authorized in this view');
  if (context && (!root || canonical(context.root) !== canonical(root))) context = undefined;
  const key = JSON.stringify([args.sessionId, root ? canonical(root) : '']);
  const now = Date.now();
  let preparation = reviewPreparations.get(key);
  if (!preparation || args.retrySync === true) {
    preparation = { startedAt: now, attemptedAt: 0, prepared: false };
    reviewPreparations.delete(key); reviewPreparations.set(key, preparation);
    while (reviewPreparations.size > 200) reviewPreparations.delete(reviewPreparations.keys().next().value!);
  }
  if (root && (args.retrySync === true || store!.needsRecovery(args.sessionId) || now - (context?.syncedAt || preparation.attemptedAt) > 2000)) {
    preparation.attemptedAt = now;
    try {
      await evidenceStore!.restore(evidence, args.sessionId, root);
      const result = await history.syncSession(args.sessionId, root, context ? freshHistoryContext(context) : { statusKnown: false, messages: evidence.messages(args.sessionId, canonical(root)) });
      preparation.prepared = result.warnings.length === 0;
      if (context) { context.syncedAt = now; context.prepared = preparation.prepared; }
    } catch {
      // Retry bounded preparation; do not expose raw errors/paths or manufacture endpoints.
      preparation.prepared = false;
      if (context) { context.syncedAt = now; context.prepared = false; }
    }
    store!.acknowledgeRecovery(args.sessionId);
  }
  const ready = context?.prepared === true;
  const summary = await s.review({ ...args, ...(ready ? {} : { focusFileId: undefined }) }, true, context);
  // File evidence readiness is independent of lifecycle certainty. Preserve unknown task state.
  const savedReady = preparation.prepared && s.hasVerifiedReviewFiles(summary.id);
  if (ready || savedReady) return { ...summary, sync: { state: 'ready' } };
  if (now - preparation.startedAt >= 15000) return { ...summary, sync: { state: 'unavailable' } };
  return { ...summary, id: `${summary.id}:pending`, files: [], nextFileOffset: null, sync: { state: 'pending' } };
}
async function execute(s: ReviewService, method: string, args: any): Promise<unknown> {
  if (method === 'openSystemFile') {
    const controller = systemOpenController;
    const resolveTarget = async () => {
      if (disposed || service !== s || controller.signal.aborted) fail('PLUGIN_UNLOADED', 'Diff view unloaded');
      try { return await s.fileOpenTarget(args); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('FILE_NOT_FOUND', '文件已不存在，无法系统打开。 / The file no longer exists.');
        throw error;
      }
    };
    const target = await resolveTarget();
    return openSystemFile(target.path, { signal: controller.signal, validate: async () => {
      const current = await resolveTarget();
      if (canonical(current.path) !== canonical(target.path)) fail('FILE_CHANGED', 'File identity changed; refresh before opening');
    } });
  }
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
    if (args.final === true) {
      await evidenceStore!.save(evidence, args.sessionId, root);
      const preparation = reviewPreparations.get(JSON.stringify([args.sessionId, canonical(root)]));
      if (preparation) preparation.attemptedAt = 0;
      const current = contexts.get(args.sessionId);
      if (current && canonical(current.root) === canonical(root)) { current.syncedAt = 0; current.prepared = false; }
    }
    return { ok: true };
  }
  if (method === 'gitManage') {
    const workspace = await pi.workspace.get();
    const roots = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
    return gitManageDispatch(method, args, roots);
  }
  if (method === 'sessionContext') {
    const root = await sessionRoot(args);
    if (!root) { const warning = '会话项目路径缺失或未授权，未导入历史。'; contexts.delete(args.sessionId); await writeCaptureContexts(store!.directory, generation, [...contexts.values()]); return { ok: false, warning }; }
    sessionRoots.set(args.sessionId, root);
    while (sessionRoots.size > 200) sessionRoots.delete(sessionRoots.keys().next().value!);
    await atomicJson(path.join(store!.directory, 'session-roots.json'), Object.fromEntries(sessionRoots));
    const now = Date.now();
    const taskId = typeof args.taskId === 'string' && /^[a-zA-Z0-9-]{1,256}$/.test(args.taskId) ? args.taskId : undefined;
    const since = Number.isSafeInteger(args.since) && args.since > 0 && args.since <= now ? args.since : undefined;
    contexts.delete(args.sessionId);
    contexts.set(args.sessionId, { sessionId: args.sessionId, root, running: args.running === true, mainRunning: typeof args.mainRunning === 'boolean' ? args.mainRunning : undefined, statusKnown: args.statusKnown !== false, taskId, since, syncedAt: 0, prepared: false, updatedAt: now });
    while (contexts.size > 200) contexts.delete(contexts.keys().next().value!);
    await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
    await evidenceStore!.restore(evidence, args.sessionId, root);
    if (!history) return { ok: false, warning: '宿主历史路径契约不匹配，未导入历史。' };
    await store!.importInbox(generation);
    const current = contexts.get(args.sessionId)!;
    const result = await history.syncSession(args.sessionId, root, freshHistoryContext(current));
    current.syncedAt = Date.now(); current.prepared = result.warnings.length === 0;
    store!.acknowledgeRecovery(args.sessionId);
    return result;
  }
  const context = typeof args?.sessionId === 'string' ? contexts.get(args.sessionId) : undefined;
  if (method === 'runningChanges' && context?.running && context.taskId === args.taskId && context.since === args.since) {
    context.updatedAt = Date.now(); await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
  }
  if (method === 'review' && (args.scope === 'turn' || args.scope === 'lastTurn')) return recordedReview(s, args, context);
  if (history && context && ['runningChanges', 'replyCards', 'bootstrap', 'turnSummary'].includes(method) && (store!.needsRecovery(args.sessionId) || Date.now() - context.syncedAt > 2000)) {
    const result = await history.syncSession(args.sessionId, context.root, freshHistoryContext(context));
    context.prepared = result.warnings.length === 0;
    context.syncedAt = Date.now(); store!.acknowledgeRecovery(args.sessionId);
  }
  if (method === 'runningChanges') {
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
    if (args.scope != null && args.scope !== 'turn' && args.scope !== 'lastTurn') fail('NAVIGATION_INVALID', 'Invalid recorded-task scope');
    if (args.scope === 'lastTurn' && (args.runningSince == null || args.fileId != null)) fail('NAVIGATION_INVALID', 'Latest-turn entry requires a running task without a fixed file');
    const version = navigationVersion;
    const run = await s.selectTarget(args);
    if (!run) fail('RUN_MISSING', 'Recorded task not found in this session');
    if (disposed || service !== s || version !== navigationVersion) fail('SELECTION_MISSING', 'Selection cleared or plugin unloaded');
    const selection = args.scope === 'lastTurn'
      ? navigation.set({ scope: 'lastTurn', sessionId: run.sessionId })
      : navigation.set({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root: run.root }, await store!.resolveFileId(args.runId, args.fileId));
    await atomicJson(path.join(store!.directory, 'selections.json'), navigation.export());
    return selection;
  }
  if (method === 'readTurnSelection') {
    if (typeof args?.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.nonce)) fail('NAVIGATION_INVALID', 'Invalid selection token');
    if (typeof args?.sessionId !== 'string' || !args.sessionId) fail('SESSION_REQUIRED', '当前视图缺少会话标识；请从本会话重新打开差异审查。');
    const selection = navigation.get(args.nonce, args.sessionId);
    if (!selection) fail('SELECTION_MISSING', '本会话的文件选择不存在或已清除；可返回本会话修改记录重新选择。');
    if (selection.request.scope === 'lastTurn') return selection;
    const target = await s.selectTarget({ runId: selection.request.runId!, sessionId: args.sessionId });
    if (target && (target.id !== selection.request.runId || target.root !== selection.request.root)) {
      const repaired = navigation.set({ ...selection.request, runId: target.id, root: target.root }, await store!.resolveFileId(selection.request.runId!, selection.fileId));
      await atomicJson(path.join(store!.directory, 'selections.json'), navigation.export()); return repaired;
    }
    return selection;
  }
  if (method === 'clearHistory' && args?.confirmed === true) {
    navigationClearing = true; navigationVersion++;
    try { await navigationTail; const result = await s.invoke(method, args); evidence.clear(); reviewPreparations.clear(); navigation.clear(); fileOpens.clear(); await atomicJson(path.join(store!.directory, 'selections.json'), []); return result; }
    finally { navigationClearing = false; }
  }
  return s.invoke(method, args);
}
