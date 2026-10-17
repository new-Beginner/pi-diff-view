import { ReadWriteQueue } from './core/read-write-queue';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewRequest, ReviewSummary } from './core/contracts';
import { SnapshotStore, atomicJson, locatorPath, readJson, type Locator } from './core/storage';
import { ReviewService } from './core/review-service';
import { fail } from './core/path-policy';
import { JobQueue } from './core/jobs';
import { ReviewNavigationStore } from './core/review-navigation';
import { ReviewSurfaces, type SurfaceRequest } from './core/review-surfaces';
const surfaces = new ReviewSurfaces();
import { HostHistoryImporter } from './core/host-history';
import { HostEvidenceStore } from './core/host-evidence-store';
let evidenceStore: HostEvidenceStore | null = null;
import { dispatch as gitManageDispatch } from './git/local-management';
import { canonical } from './core/path-policy';
import { CAPTURE_CONTEXT_TTL, writeCaptureContexts, type CaptureContext } from './core/capture-context';
import { HostEvidenceBuffer } from './core/host-evidence-buffer';
import { createPublicHostSource, type PublicHostSnapshot } from './core/public-host-source';
import { publicSessionContext } from './core/public-session-context';
import { evidenceChunks, evidenceRevision, hostEvidenceMessages } from './core/host-transcript';
import { inspectCaptureLeases, retireLegacyCaptureLeases } from './core/capture-leases';
let publicSource: ReturnType<typeof createPublicHostSource> | null = null;
const publicUpdates = new Map<string, { snapshot: PublicHostSnapshot; observedAt: number }>();
import { closeSystemOpener, openSystemFile, warmSystemOpener } from './core/system-open';
let systemOpenController = new AbortController();
const evidence = new HostEvidenceBuffer();
let history: HostHistoryImporter | null = null;
type SessionContext = CaptureContext & { syncedAt: number; prepared?: boolean; evidenceComplete?: boolean };
const contexts = new Map<string, SessionContext>();
// Generation-local and bounded: never wait here for renderer work queued behind review.
const reviewPreparations = new Map<string, { startedAt: number; attemptedAt: number; prepared: boolean }>();
const sessionRoots = new Map<string, string>();
const freshHistoryContext = (context: SessionContext) => ({ ...context, statusKnown: context.statusKnown === true && context.evidenceComplete !== false && Date.now() - context.updatedAt <= CAPTURE_CONTEXT_TTL, messages: evidence.messages(context.sessionId, canonical(context.root)) });
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
const savedReads = new Set<Promise<unknown>>();
const savedRefreshes = new Map<string, Promise<unknown>>();
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
/** Only snapshot reads bypass history work; all recovery/mutation stays on the existing queue. */
function queueSavedRefresh(s: ReviewService, method: string, args: any, root: string): void {
  const key = JSON.stringify([args.sessionId, canonical(root)]);
  if (savedRefreshes.has(key)) return;
  const version = navigationVersion;
  const task = serial(async () => {
    if (disposed || service !== s || navigationClearing || version !== navigationVersion) return;
    await execute(s, method, args);
  });
  savedRefreshes.set(key, task);
  const settled = () => { if (savedRefreshes.get(key) === task) savedRefreshes.delete(key); };
  void task.then(settled, settled);
}
function trySavedRead(s: ReviewService, method: string, args: any): Promise<{ result: unknown } | undefined> {
  const version = navigationVersion;
  const current = () => { if (disposed || service !== s || navigationClearing || version !== navigationVersion) fail('SELECTION_MISSING', 'Saved history cleared or plugin unloaded'); };
  const task = (async () => {
    current();
    if (method === 'replyCards') {
      // Never write an old run back while the importer is updating its evidence.
      const result = await s.replyCards(args, false); current();
      const context = contexts.get(args.sessionId);
      if (history && context && (store!.needsRecovery(args.sessionId) || Date.now() - context.syncedAt > 2000)) queueSavedRefresh(s, method, args, context.root);
      return { result };
    }
    if (['file', 'reviewFiles'].includes(method) && s.isReadOnlyReview(args.reviewId)) {
      const result = await s.invoke(method, args); current(); return { result };
    }
    if (!history || method !== 'review' || args.scope !== 'turn' || args.retrySync) return;
    const summary = await s.savedReview(args); current();
    if (!summary) return; // Running, missing, conflicting or unbound evidence uses normal recovery.
    const key = JSON.stringify([args.sessionId, canonical(summary.root)]), now = Date.now();
    const context = contexts.get(args.sessionId), preparation = reviewPreparations.get(key);
    const ready = context && canonical(context.root) === canonical(summary.root) && context.prepared && now - context.syncedAt <= 2000;
    if (!store!.needsRecovery(args.sessionId) && (ready || (preparation?.prepared && now - preparation.attemptedAt <= 2000))) return;
    if (!preparation) {
      reviewPreparations.set(key, { startedAt: now, attemptedAt: 0, prepared: false });
      while (reviewPreparations.size > 200) reviewPreparations.delete(reviewPreparations.keys().next().value!);
    }
    queueSavedRefresh(s, method, args, summary.root);
    const state = now - (preparation?.startedAt ?? now) >= 15000 ? 'unavailable' : 'pending';
    return { result: { ...summary, sync: { state, saved: true } } };
  })();
  savedReads.add(task);
  void task.then(() => savedReads.delete(task), () => savedReads.delete(task));
  return task;
}
function schedule(s: ReviewService, method: string, args: any): Promise<unknown> {
  const work = async () => { if (disposed || service !== s) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args); };
  if (method === 'openSystemFile') return work();
  if (method === 'replyCards' || (method === 'review' && args?.scope === 'turn' && !args.retrySync) || (['file', 'reviewFiles'].includes(method) && s.isReadOnlyReview(args?.reviewId))) {
    return trySavedRead(s, method, args).then(saved => saved ? saved.result : serial(work));
  }
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
  surfaces.clear();
  systemOpenController = new AbortController();
  const dataPath = await pi.plugin.getDataPath(); store = new SnapshotStore(dataPath); await store.init();
  evidenceStore = new HostEvidenceStore(dataPath);
  history = new HostHistoryImporter(store);
  publicSource?.close();
  publicSource = createPublicHostSource({ desktop: pi.desktop ? { listOperations: () => pi.desktop.listOperations(), invoke: input => pi.desktop.invoke(input) } : undefined });
  publicUpdates.clear();
  contexts.clear(); evidence.clear(); reviewPreparations.clear();
  savedRefreshes.clear();
  sessionRoots.clear();
  const savedRoots = await readJson<Record<string, string>>(path.join(store.directory, 'session-roots.json'), {});
  for (const [id, root] of Object.entries(savedRoots).slice(-200)) if (/^[a-zA-Z0-9-]{1,80}$/.test(id) && typeof root === 'string' && path.isAbsolute(root)) sessionRoots.set(id, root);
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
  warmSystemOpener();
}
export async function onUnload(): Promise<void> {
  disposed = true; if (timer) clearInterval(timer); timer = undefined;
  publicSource?.close(); publicSource = null; publicUpdates.clear();
  surfaces.clear();
  systemOpenController.abort();
  closeSystemOpener();
  if (turnEnded) pi.events.off('session:turnEnded', turnEnded); turnEnded = undefined;
  jobs?.close(); jobs = null; navigation.clear();
  await tail;
  await Promise.allSettled([...savedReads]);
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
  if (method === 'sessionState') {
    const source = publicSource!, s = service, id = (args as any)?.sessionId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('SESSION_REQUIRED', 'Invalid session identity');
    const snapshot = await source.read(id);
    if (disposed || service !== s || publicSource !== source) fail('PLUGIN_UNLOADED', 'Diff view unloaded');
    const context = publicSessionContext(snapshot);
    if (!publicUpdates.has(id)) {
      publicUpdates.set(id, { snapshot, observedAt: Date.now() });
      void serial(async () => {
        const latest = publicUpdates.get(id); publicUpdates.delete(id);
        if (!disposed && service === s && latest) await applyPublicSnapshot(latest.snapshot, undefined, latest.observedAt);
      }).catch(() => {});
    } else publicUpdates.set(id, { snapshot, observedAt: Date.now() });
    return { ...context, updatedAt: undefined, evidenceRevision: evidenceRevision(JSON.stringify(snapshot.messages)) };
  }
  if (method === 'reviewSurface') {
    const request = args as SurfaceRequest;
    if (request?.nonce != null) {
      const selection = navigation.get(request.nonce, request.sessionId);
      if (!selection || selection.revision !== request.selectionRevision) fail('SELECTION_MISSING', 'Selection changed; click again');
    }
    return surfaces.request(request);
  }
  if (method === 'selectTurn') {
    if (navigationClearing) fail('SELECTION_MISSING', 'History is being cleared');
    const s = service;
    const result = navigationTail.catch(() => {}).then(async () => { if (disposed || service !== s) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); return execute(s, method, args ?? {}); });
    navigationTail = result.catch(() => {}); return result;
  }
  if (method === 'activeReviewSession' || method === 'readTurnSelection' || method === 'openSystemFile') return execute(service, method, args ?? {}); // Volatile UI state must not queue behind long Git jobs.
  if (method === 'rendererReport') {
    const stage = (args as { stage?: unknown } | null)?.stage;
    if (typeof stage !== 'string' || !/^(entry-loaded|reply-slot-mounted|card-bound|session-ready|session-source-error|sidebar-opened|view-targeted|bootstrap-ok|bootstrap-error|card-query-error|composer-mounted|composer-source-error|composer-layer-error|composer-anchor-missing|composer-anchor-offscreen|composer-positioned|running-idle|running-identity-missing|running-ready|running-query-empty|running-query-error|running-visible|running-click-error)$/.test(stage)) fail('INVALID_STAGE', 'Unknown renderer diagnostic stage');
    return serial(async () => { if (disposed || !store) fail('PLUGIN_UNLOADED', 'Diff view unloaded'); rendererStages[stage] = Date.now(); rendererDiagnostic = { stage, at: Date.now() }; await saveRendererStatus(); return { ok: true }; });
  }
  if (method === 'jobStart') {
    const a = args as { method: string; args?: unknown; waitMs?: number; queueIfBusy?: boolean }, currentJobs = jobs!;
    const started = currentJobs.admit(a.method, a.args ?? {}, a.queueIfBusy === true);
    if (!('jobId' in started)) return started;
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
  if (retained && (!args.root || canonical(args.root) === canonical(retained))) return retained;
  const recorded = (await store!.listRuns(false, true)).filter(run => run.sessionId === args.sessionId && (!args.root || canonical(run.root) === canonical(args.root)));
  const candidates = [...new Set(recorded.map(run => canonical(run.root)))];
  return candidates.length === 1 ? recorded[0].root : undefined;
}
async function applyPublicSnapshot(snapshot: PublicHostSnapshot, fallbackRoot?: string, observedAt = Date.now()): Promise<SessionContext | undefined> {
  const metadata = publicSessionContext(snapshot, observedAt);
  // Public session ownership authorizes recording only, never workspace mutation.
  if (metadata.root) sessionRoots.set(snapshot.sessionId, metadata.root);
  const root = await sessionRoot({ sessionId: snapshot.sessionId, root: metadata.root ?? fallbackRoot });
  if (!root) {
    contexts.delete(snapshot.sessionId);
    await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
    return;
  }
  sessionRoots.set(snapshot.sessionId, root);
  while (sessionRoots.size > 200) sessionRoots.delete(sessionRoots.keys().next().value!);
  await atomicJson(path.join(store!.directory, 'session-roots.json'), Object.fromEntries(sessionRoots));
  await evidenceStore!.restore(evidence, snapshot.sessionId, root);
  const text = JSON.stringify(hostEvidenceMessages(snapshot.messages, snapshot.sessionId, root)), revision = evidenceRevision(text), chunks = evidenceChunks(text);
  for (const [index, chunk] of chunks.entries()) evidence.append({ sessionId: snapshot.sessionId, root: canonical(root), revision, index, chunk, final: index === chunks.length - 1 });
  if (snapshot.messages.length) await evidenceStore!.save(evidence, snapshot.sessionId, root);
  const previous = contexts.get(snapshot.sessionId);
  const context: SessionContext = { ...metadata, root, syncedAt: previous?.syncedAt ?? 0, prepared: previous?.prepared, evidenceComplete: snapshot.complete };
  contexts.delete(snapshot.sessionId); contexts.set(snapshot.sessionId, context);
  while (contexts.size > 200) contexts.delete(contexts.keys().next().value!);
  await writeCaptureContexts(store!.directory, generation, [...contexts.values()]);
  return context;
}
async function recordedReview(s: ReviewService, args: ReviewRequest, context?: SessionContext): Promise<ReviewSummary> {
  if (!history) return s.review(args);
  if (typeof args.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId)) fail('SESSION_REQUIRED', 'Invalid session identity');
  if (args.scope === 'turn' && (typeof args.runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.runId))) fail('INVALID_ID', 'A valid runId is required');
  await store!.importInbox(generation);
  const recorded = args.runId ? await store!.getRun(args.runId, false, false) : (await store!.listRuns(false, true)).find(run => run.sessionId === args.sessionId && (!args.root || canonical(run.root) === canonical(args.root)));
  const owned = recorded?.sessionId === args.sessionId ? recorded : undefined;
  if (!context || Date.now() - context.updatedAt > 1000 || args.retrySync) {
    if (args.retrySync) publicSource!.invalidate(args.sessionId);
    const snapshot = await publicSource!.read(args.sessionId);
    context = await applyPublicSnapshot(snapshot, args.root ?? owned?.root) ?? context;
  }
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
      if (context) { context.syncedAt = Date.now(); context.prepared = preparation.prepared; }
    } catch {
      // Retry bounded preparation; do not expose raw errors/paths or manufacture endpoints.
      preparation.prepared = false;
      if (context) { context.syncedAt = Date.now(); context.prepared = false; }
    }
    preparation.attemptedAt = Date.now();
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
async function captureMaintenance(args: any): Promise<unknown> {
  if (!args || !['inspect', 'retire'].includes(args.action) || typeof args.root !== 'string' || !path.isAbsolute(args.root)) fail('INVALID_MAINTENANCE', 'Invalid capture maintenance request');
  const workspace = await pi.workspace.get();
  const roots: string[] = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
  if (!roots.some(root => canonical(root) === canonical(args.root))) fail('ROOT_DENIED', 'Only an authorized workspace root can be maintained');
  if (args.action === 'inspect') {
    if (Object.keys(args).some(key => !['action', 'root'].includes(key))) fail('INVALID_MAINTENANCE', 'Unexpected inspect fields');
    const inspected = await inspectCaptureLeases(store!);
    const leases = inspected.leases.filter(lease => canonical(lease.root) === canonical(args.root) && !lease.sessionId && !lease.toolCallId && !lease.executionId);
    return { root: args.root, fingerprint: inspected.fingerprint, ids: leases.map(lease => lease.id), count: leases.length };
  }
  if (Object.keys(args).some(key => !['action', 'root', 'ids', 'fingerprint', 'writersStopped'].includes(key)) || !Array.isArray(args.ids) || !args.ids.length || args.ids.length > 256 || args.ids.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) || typeof args.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(args.fingerprint) || args.writersStopped !== true) fail('INVALID_MAINTENANCE', 'Explicit stopped-writer confirmation, exact IDs and fingerprint are required');
  await retireLegacyCaptureLeases(store!, args.root, args.ids, args.fingerprint, true);
  for (const context of contexts.values()) if (canonical(context.root) === canonical(args.root)) { context.prepared = false; context.syncedAt = 0; }
  for (const key of reviewPreparations.keys()) if (JSON.parse(key)[1] === canonical(args.root)) reviewPreparations.delete(key);
  await store!.audit({ action: 'capture-legacy-leases-retired', root: canonical(args.root), ids: args.ids, fingerprint: args.fingerprint });
  return { ok: true, count: args.ids.length };
}
async function execute(s: ReviewService, method: string, args: any): Promise<unknown> {
  if (method === 'captureMaintenance') return captureMaintenance(args);
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
  if (method === 'sessionEvidence') fail('PUBLIC_SOURCE_REQUIRED', 'Evidence is collected by the backend public source');
  if (method === 'gitManage') {
    const workspace = await pi.workspace.get();
    const roots = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r: any) => typeof r === 'string' ? r : r.path)] : [];
    return gitManageDispatch(method, args, roots);
  }
  if (method === 'sessionContext') {
    const snapshot = await publicSource!.read(args.sessionId);
    const current = await applyPublicSnapshot(snapshot, args.root);
    if (!current) return { ok: false, warning: '会话项目路径缺失或未核验；未导入历史。' };
    await store!.importInbox(generation);
    const result = await history!.syncSession(args.sessionId, current.root, freshHistoryContext(current));
    current.syncedAt = Date.now(); current.prepared = result.warnings.length === 0;
    store!.acknowledgeRecovery(args.sessionId);
    return result;
  }
  const context = typeof args?.sessionId === 'string' ? contexts.get(args.sessionId) : undefined;
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
    if (args.scope === 'lastTurn') {
      if (typeof args.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId) || args.fileId != null || args.root != null) fail('NAVIGATION_INVALID', 'Latest-turn entry requires a session without a fixed file or project');
      const selection = navigation.set({ scope: 'lastTurn', sessionId: args.sessionId });
      await atomicJson(path.join(store!.directory, 'selections.json'), navigation.export());
      return selection;
    }
    if (typeof args?.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 128 || typeof args?.runId !== 'string' || !args.runId || args.runId.length > 128 || (args.fileId != null && (typeof args.fileId !== 'string' || args.fileId.length > 256))) fail('NAVIGATION_INVALID', 'Invalid recorded-task target');
    if (args.scope != null && args.scope !== 'turn' && args.scope !== 'lastTurn') fail('NAVIGATION_INVALID', 'Invalid recorded-task scope');
    const version = navigationVersion;
    const run = await s.selectTarget(args);
    if (!run) fail('RUN_MISSING', 'Recorded task not found in this session');
    if (disposed || service !== s || version !== navigationVersion) fail('SELECTION_MISSING', 'Selection cleared or plugin unloaded');
    const selection = navigation.set({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root: run.root }, await store!.resolveFileId(args.runId, args.fileId));
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
    surfaces.clear();
    try { await navigationTail; await Promise.allSettled([...savedReads]); const result = await s.invoke(method, args); evidence.clear(); reviewPreparations.clear(); navigation.clear(); await atomicJson(path.join(store!.directory, 'selections.json'), []); return result; }
    finally { navigationClearing = false; }
  }
  return s.invoke(method, args);
}
