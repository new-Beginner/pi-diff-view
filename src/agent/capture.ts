import { assertSessionScratchPath } from '../core/public-path';
import { safeDelegation, safeTaskDetails } from '../core/delegation-lifecycle';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_CAPTURE_SEGMENTS, type CaptureRun, type FileSnapshot } from '../core/contracts';
import { absentSnapshot, digest, readCapturedSnapshot, resolveCapturePath, sameSnapshot } from '../core/path-policy';
import { locatorPath, resolveLocator, SnapshotStore } from '../core/storage';
import { isImagePath } from '../core/review-file-policy';
import { explicitToolName, isExplicitFileTool, isReplacementTool } from '../core/explicit-file-tools';
import { snapshotWorkspace, WORKSPACE_NOTICE, type CapturedPath } from './workspace-capture';
import { beginCaptureLease, closeCaptureLease, endCaptureLease, prepareCaptureLease } from '../core/capture-leases';
import { checkScratchAncestry, readCaptureContext } from '../core/capture-context';
interface Pending { run: CaptureRun; paths: CapturedPath[]; store: SnapshotStore; lease: string; name: string; workspace: boolean; complete: boolean; task: boolean; finished?: boolean; retainPreparation?: boolean; }
const toolName = explicitToolName;
interface Context { cwd: string; sessionManager: { getSessionId(): string }; ui?: { notify(message: string, level?: string): void }; }
interface Extension { on(event: string, handler: (event: any, ctx: Context) => unknown): void; }
interface Options { pluginRoot: string; locator?: string; }
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
function textContent(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
}
function toolPaths(name: string, input: any): { targets: string[]; hadTargets: boolean; truncated: boolean } {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== 'string' || !isExplicitFileTool(name) || (isReplacementTool(name) && input?.dry_run === true)) return { targets: [], hadTargets: false, truncated: false };
  const targets = new Set<string>(); let hadTargets = false, truncated = false;
  const add = (target: string) => { hadTargets = true; if (!isImagePath(target)) targets.add(target); };
  add(p);
  if (/^edit$/i.test(name) && typeof input.ops === 'string') {
    let scanned = 0;
    for (const line of input.ops.split('\n')) if (line.startsWith('MV ')) {
      if (++scanned > 4096) { truncated = true; break; }
      add(line.slice(3).trim());
      if (targets.size > 256) { truncated = true; break; }
    }
  }
  return { targets: [...targets], hadTargets, truncated };
}
/** One closure per runner; workspace discovery is bounded and never uses Git. */
export function createCaptureExtension(options: Options): (pi: Extension) => void {
  return pi => {
    let run: CaptureRun | null = null, store: SnapshotStore | null = null;
    const pending = new Map<string, Pending>();
    const taskCalls = new Map<string, CaptureRun>();
    // A late terminal result retires its own interval without sampling a newer task.
    const detached = new Map<string, { store: SnapshotStore; lease: string; sessionId: string }>();
    const detachPending = () => { for (const [id, value] of pending) detached.set(id, { store: value.store, lease: value.lease, sessionId: value.run.sessionId }); pending.clear(); };
    const retiredReplies = new Set<string>();
    const waits = new Set<string>();
    let seen = new Set<string>(), retired = new Set<string>(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply: CaptureRun['finalReply'], privatePaths: string[] = [], observed = new Set<string>(), settled = false;
    let diagnosticCount = 0;
    const diagnose = async (target: CaptureRun | null, stage: string, error: unknown, ctx?: Context, file?: string) => {
      if (target) { target.incomplete = true; target.notice = '部分快照采集失败；行数可能未知。请检查存储空间、文件权限及 actions.jsonl 诊断。'; }
      const raw = (error as NodeJS.ErrnoException)?.code;
      const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) ? raw : 'CAPTURE_FAILED';
      if (diagnosticCount++ < 16) await store?.audit({ action: `capture-${stage}`, code, runId: target?.id, ...(file ? { pathId: digest(file).slice(0, 24) } : {}) }).catch(() => {});
      if (!warned && ctx && code !== 'PATH_DENIED') { warned = true; ctx.ui?.notify(`Diff view: 快照采集降级 (${code})；请检查文件权限、存储空间及 actions.jsonl。`, 'warning'); }
    };
    const serial = (fn: () => Promise<void>, ctx: Context): Promise<void> => {
      tail = tail.then(fn).catch(async error => {
        lastReply = undefined;
        if (run) { run.incomplete = true; delete run.finalReply; await persist(run).catch(() => {}); }
        await diagnose(run, 'persist', error, ctx);
      });
      return tail;
    };
    const bridge = async () => resolveLocator(options.locator ?? await locatorPath(options.pluginRoot), options.pluginRoot);
    const check = async (target: CaptureRun) => {
      const locator = await bridge();
      if (locator.generation !== target.generation || locator.dataPath !== store?.directory) {
        store = new SnapshotStore(locator.dataPath); await store.init();
        target.generation = locator.generation;
        privatePaths = [...new Set([...privatePaths, await fs.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)])];
        if (!target.notice?.includes('Capture locator refreshed')) target.notice = `${target.notice ?? ''} Capture locator refreshed during the current user task.`.trim();
      }
      return locator;
    };
    const persist = async (target: CaptureRun) => {
      await check(target);
      if (target.mainState) {
        const children = target.delegations ?? [];
        target.state = target.mainState === 'running' || children.some(child => child.status === 'running') ? 'running'
          : target.mainState === 'aborted' || children.some(child => ['aborted', 'stopped'].includes(child.status)) ? 'aborted'
          : target.mainState === 'incomplete' || children.some(child => child.status === 'failed') ? 'incomplete' : target.mainState;
        if (target.state === 'running') delete target.endedAt;
        else target.endedAt ??= Date.now();
      }
      target.fileCount = Object.values(target.changes).filter(c => !c.ambiguous && !sameSnapshot(c.before, c.after)).length;
      target.contentVersion = (target.contentVersion ?? 0) + 1;
      await store!.writeRun(target, true);
      // Segment blobs were persisted above; do not retain/re-hash every earlier full text on each call.
      for (const change of Object.values(target.changes)) for (const segment of change.segments ?? []) {
        segment.before = { ...segment.before, text: null }; segment.after = { ...segment.after, text: null };
      }
    };
    const bounded = (snapshot: FileSnapshot, extra: FileSnapshot[] = []): FileSnapshot => {
      const retained = new Set([...Object.values(run!.changes).flatMap(c => [c.before, c.after]), ...[...pending.values()].flatMap(p => p.paths.map(e => e.before)), ...extra]);
      const used = [...retained].reduce((n, s) => n + (s.text === null ? 0 : s.size), 0);
      if (snapshot.text !== null && used + snapshot.size > MAX_CAPTURE_BYTES) {
        run!.incomplete = true; return { ...snapshot, kind: 'unavailable', text: null };
      }
      return snapshot;
    };
    const begin = async (ctx: Context, uncertain = false, event?: any) => {
      if (disposed) return;
      const locator = await bridge();
      for (const reply of run?.replies ?? []) retiredReplies.add(`${reply.timestamp}:${reply.hash}`);
      while (retiredReplies.size > 200) retiredReplies.delete(retiredReplies.keys().next().value!);
      if (run?.execution?.state === 'running') { run.mainState = 'incomplete'; run.state = 'incomplete'; run.incomplete = true; run.execution = { ...run.execution, revision: run.execution.revision + 1, state: 'settled' }; delete run.finalReply; run.endedAt = Date.now(); await persist(run); }
      store = new SnapshotStore(locator.dataPath); await store.init();
      privatePaths = [await fs.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      // User-task boundary, not a model/tool-loop turn; prompts are never retained.
      await checkScratchAncestry(ctx.cwd);
      const root = await fs.realpath(ctx.cwd);
      assertSessionScratchPath(root, ctx.sessionManager.getSessionId(), root);
      const identity = await readCaptureContext(locator.dataPath, locator.generation, ctx.sessionManager.getSessionId(), root);
      run = { version: 2, contentVersion: 0, boundary: uncertain && !identity ? 'uncertain' : 'user', id: randomUUID(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root, startedAt: Date.now(), state: 'running', fileCount: 0, incomplete: uncertain, changes: Object.create(null), replies: [], bindings: {} };
      run.execution = { id: randomUUID(), revision: 1, state: 'running' };
      run.mainState = 'running';
      const userId = event?.userMessageId ?? (event?.message?.role === 'user' ? event.message.id : undefined) ?? identity?.taskId;
      if (typeof userId === 'string' && userId.length > 0 && userId.length <= 256) run.userMessageId = userId;
      if (uncertain && identity) run.notice = '运行身份已由同会话、同项目的宿主元数据核验；仅记录采集开始后的有界变更。';
      for (const id of seen) retired.add(id);
      while (retired.size > 4096) retired.delete(retired.keys().next().value!);
      detachPending(); waits.clear(); seen.clear(); observed.clear(); warned = false; diagnosticCount = 0; lastReply = undefined; settled = false;
      await persist(run);
    };
    pi.on('before_agent_start', (event, ctx) => serial(() => begin(ctx, false, event), ctx));
    pi.on('agent_start', (_event, ctx) => serial(async () => {
      // Desktop forwards internal end/start pairs for steering and retries without a new USER boundary.
      // Keep first-before snapshots and tool identities instead of beginning an uncertain second task.
      if (disposed || settled || !run || run.execution?.state === 'running' || run.mainState === 'aborted' || run.sessionId !== ctx.sessionManager.getSessionId() || run.root !== await fs.realpath(ctx.cwd)) return;
      await check(run);
      run.state = 'running'; delete run.endedAt; delete run.finalReply; delete run.cardPreview;
      run.mainState = 'running';
      if (run.execution) run.execution = { ...run.execution, revision: run.execution.revision + 1, state: 'running' };
      run.bindings = {}; lastReply = undefined;
      await persist(run);
    }, ctx));
    pi.on('tool_call', (event, ctx) => serial(async () => {
      if (disposed || typeof event.toolCallId !== 'string' || seen.has(event.toolCallId)) return;
      lastReply = undefined;
      if (!run || run.state !== 'running') await begin(ctx, true);
      if (!run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      if (retired.has(event.toolCallId)) { if (run) { run.incomplete = true; await persist(run); } return; }
      if (seen.size >= 4096 || pending.size >= 256 || event.toolCallId.length > 256) { run.incomplete = true; await persist(run); return; }
      await check(run); seen.add(event.toolCallId);
      const name = toolName(event.toolName), targetSet = toolPaths(name, event.input ?? event.args), targets = targetSet.targets;
      if (isReplacementTool(name) && targets.length) {
        // Directory replacement is deliberately not expanded, even when a glob is supplied.
        try { if (!(await fs.lstat(path.resolve(run.root, targets[0]))).isFile()) return; } catch { return; }
      }
      // Workspace snapshots cannot prove which process authored a file.
      // Only exact file adapters are eligible; arbitrary plugin path arguments are not evidence.
      if (name === 'task') {
        if ((run.delegations?.length ?? 0) >= 256) { run.incomplete = true; await persist(run); return; }
        (run.delegations ??= []).push({ callId: event.toolCallId, owner: run.userMessageId ?? run.id, status: 'running' });
        taskCalls.set(event.toolCallId, run);
        for (const [id, target] of taskCalls) if (taskCalls.size > 4096 && target.delegations?.every(child => child.status !== 'running')) taskCalls.delete(id);
        await persist(run); return;
      }
      if (['bash', 'shell', 'task', 'taskwait', 'task_wait'].includes(name)) return;
      const workspace = false;
      if (name === 'taskwait' || name === 'task_wait') {
        // Wait results are sampling points, not proof that every delegated task ended.
        waits.add(event.toolCallId);
        return;
      }
      if (targetSet.hadTargets && targets.length === 0 && !targetSet.truncated) return;
      if (!targets.length && !workspace) {
        if (['write', 'edit'].includes(name)) { run.incomplete = true; await persist(run); }
        return;
      }
      const leaseStore = store!, lease = await beginCaptureLease(leaseStore, run.root, run.id, targets.slice(0, 256).map(p => path.resolve(run!.root, p)), { sessionId: run.sessionId, toolCallId: event.toolCallId, executionId: run.execution?.id });
      const captured: Pending = { run, paths: [], store: leaseStore, lease, name, workspace, complete: true, task: name === 'task' };
      // Install before any read so failures never leave an untracked running interval.
      pending.set(event.toolCallId, captured);
      if (workspace) {
        const snapshot = await snapshotWorkspace(run.root, privatePaths);
        captured.complete = snapshot.complete;
        for (const entry of snapshot.paths) captured.paths.push({ ...entry, before: bounded(entry.before) });
        run.notice = WORKSPACE_NOTICE + (captured.task ? ' Task is sampled at TaskWait/agent_end, not at launch; child runners should load this extension. Parent endpoints are ambiguous and do not prove child completion.' : ' Shell coverage ends at tool_result; background writes after return are unsupported.');
        if (!snapshot.complete || captured.task) run.incomplete = true;
      } else {
        if (targetSet.truncated || targets.length > 256) run.incomplete = true;
        for (const [index, target] of targets.slice(0, 256).entries()) {
          try {
            assertSessionScratchPath(path.resolve(run.root, target), run.sessionId, run.root);
            const capture = await resolveCapturePath(run.root, target, privatePaths, name === 'write' || index > 0);
            if (!observed.has(capture.identity) && observed.size >= 256) throw new Error('Turn exceeds 256 explicitly captured files');
            observed.add(capture.identity);
            const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captured.paths.map(e => e.before));
            if (before.kind !== 'text') await diagnose(run, 'before', { code: 'SNAPSHOT_UNAVAILABLE' }, ctx, capture.identity);
            captured.paths.push({ capture, before });
          } catch (error) { await diagnose(run, 'before', error, ctx, target); }
        }
      }
      try { await prepareCaptureLease(leaseStore, lease, { name, userMessageId: run.userMessageId, paths: captured.paths }); }
      catch (error) { await diagnose(run, 'prepare', error, ctx); }
      await persist(run);
    }, ctx));
    const finish = async (id: string, captured: Pending, isError = false, sample = false) => {
      const target = captured.run;
      if (captured.finished) { await persist(target); if (!captured.retainPreparation) await endCaptureLease(captured.store, captured.lease); pending.delete(id); return; }
      await check(target);
      const pairs: { entry: CapturedPath; after: FileSnapshot; uncertain?: boolean }[] = [];
      const retain = (snapshot: FileSnapshot) => bounded(snapshot, pairs.map(pair => pair.after));
      if (captured.workspace) {
        const current = await snapshotWorkspace(target.root, privatePaths);
        if (!current.complete) target.incomplete = true;
        const remaining = new Map(current.paths.map(e => [e.capture.identity, e]));
        for (const entry of captured.paths) {
          const live = remaining.get(entry.capture.identity);
          remaining.delete(entry.capture.identity);
          try { pairs.push({ entry, after: retain(live?.before ?? await readCapturedSnapshot(target.root, entry.capture, privatePaths)) }); }
          catch { target.incomplete = true; }
        }
        for (const entry of remaining.values()) pairs.push({ entry: { capture: entry.capture, before: absentSnapshot() }, after: retain(entry.before), uncertain: !captured.complete });
      } else for (const entry of captured.paths) {
        try { pairs.push({ entry, after: retain(await readCapturedSnapshot(target.root, entry.capture, privatePaths)) }); }
        catch (error) { await diagnose(target, 'after', error); }
      }
      // End the mutation interval but retain preparation until the result is durable.
      const overlap = sample ? true : (await closeCaptureLease(captured.store, captured.lease)) || captured.store.directory !== store!.directory;
      if (isError) target.incomplete = true;
      for (const { entry, after: rawAfter, uncertain } of pairs) {
        if (sameSnapshot(entry.before, rawAfter)) continue; // no ghost entries for no-op tools
        const priorKey = Object.keys(target.changes).find(p => target.changes[p].capture?.identity === entry.capture.identity);
        const prior = priorKey ? target.changes[priorKey] : undefined;
        if (!prior && Object.keys(target.changes).length >= 256) { target.incomplete = true; continue; }
        const intervalAmbiguous = !!(overlap || uncertain || captured.task || isError);
        const ambiguous = !!(intervalAmbiguous || prior?.ambiguous || (prior && !sameSnapshot(prior.after, entry.before)));
        const rawSegmentAfter = bounded(rawAfter, captured.paths.map(e => e.before));
        const segment = { before: entry.before, after: rawSegmentAfter, evidence: `${captured.name}:${id}`, ...(intervalAmbiguous ? { ambiguous: true } : {}) };
        const segments = [...(prior?.segments ?? []), segment];
        const segmentsTruncated = !!prior?.segmentsTruncated || segments.length > MAX_CAPTURE_SEGMENTS;
        if (segmentsTruncated) target.incomplete = true;
        let before = prior?.before ?? entry.before, after = rawSegmentAfter;
        if (ambiguous) {
          before = { ...before, text: null, kind: 'unavailable' }; after = { ...after, text: null, kind: 'unavailable' };
          target.incomplete = true;
        }
        if (after.kind !== 'text') target.incomplete = true;
        target.changes[priorKey ?? entry.capture.path] = {
          capture: prior?.capture ?? entry.capture, before, after,
          evidence: [...(prior?.evidence ?? []), `${captured.name}:${id}`].slice(-32),
          segments: segments.slice(-MAX_CAPTURE_SEGMENTS), ...(segmentsTruncated ? { segmentsTruncated: true } : {}),
          ...(captured.workspace && !ambiguous ? { note: 'Observed workspace endpoints during a tool interval, not authoritative process-level authorship evidence.' } : {}),
          ...(ambiguous ? { ambiguous: true, note: 'Overlapping, discontinuous or delegated capture interval: file ownership is uncertain; diff and line counts unavailable.' } : {}),
        };
      }
      if (sample) {
        // Checkpoint observed endpoints so a later restoration is retained as net-zero evidence.
        captured.paths = [];
        for (const pair of pairs.slice(0, 256)) captured.paths.push({ capture: pair.entry.capture, before: bounded(pair.after) });
      }
      if (!sample) { captured.finished = true; captured.retainPreparation = pairs.length < captured.paths.length; }
      await persist(target);
      if (!sample) { if (!captured.retainPreparation) await endCaptureLease(captured.store, captured.lease); pending.delete(id); }
    };
    const updateDelegations = async (event: any, ctx: Context) => {
      const details = event.details ?? event.message?.toolResult?.details;
      const name = toolName(event.toolName ?? event.message?.toolName);
      const changed = new Set<CaptureRun>();
      const target = taskCalls.get(event.toolCallId ?? event.message?.toolCallId);
      if (name === 'task' && target?.sessionId === ctx.sessionManager.getSessionId()) {
        const child = target.delegations?.find(child => child.callId === (event.toolCallId ?? event.message?.toolCallId));
        const sample = safeDelegation(details);
        if (child && child.status === 'running' && (event.isError || sample) && (!sample || !child.startedAt || child.startedAt === sample.startedAt)) {
          Object.assign(child, event.isError ? { status: 'failed' } : sample); changed.add(target);
        }
      }
      const samples = name === 'task' ? [] : Object.values(safeTaskDetails(name, details) ?? {}).flat();
      for (const sample of samples) for (const target of new Set(taskCalls.values())) {
        if (target.sessionId !== ctx.sessionManager.getSessionId()) continue;
        const child = target.delegations?.find(child => child.delegationId === sample.delegationId && child.startedAt === sample.startedAt);
        if (child?.status === 'running') { Object.assign(child, sample); changed.add(target); }
      }
      for (const target of changed) {
        if (target.execution) target.execution = { ...target.execution, revision: target.execution.revision + 1 };
        await persist(target);
      }
    };
    pi.on('tool_result', (event, ctx) => serial(async () => {
      await updateDelegations(event, ctx);
      const old = detached.get(event.toolCallId);
      if (old && old.sessionId === ctx.sessionManager.getSessionId()) {
        await closeCaptureLease(old.store, old.lease); detached.delete(event.toolCallId); return;
      }
      if (disposed || !run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      const captured = pending.get(event.toolCallId);
      if (!captured) {
        if (waits.delete(event.toolCallId) || ['taskwait', 'task_wait'].includes(toolName(event.toolName))) for (const [id, task] of pending) if (task.task) await finish(id, task, !!event.isError, true);
        return;
      }
      if (captured.run !== run || run.state !== 'running') return;
      lastReply = undefined;
      if (captured.task) { await persist(run); return; } // Task result is a launch acknowledgement
      await finish(event.toolCallId, captured, !!event.isError);
    }, ctx));
    pi.on('message_end', (event, ctx) => serial(async () => {
      await updateDelegations(event, ctx);
      if (!run || run.state !== 'running' || run.sessionId !== ctx.sessionManager.getSessionId() || event.message?.role !== 'assistant') return;
      const message = event.message, text = textContent(message);
      lastReply = undefined;
      const tools = Array.isArray(message.content) && message.content.some((b: any) => b.type === 'toolCall' || b.type === 'tool_use');
      if (tools || !text.trim()) return;
      // A missing timestamp cannot safely bind a host message later.
      if (!Number.isFinite(message.timestamp)) { run.incomplete = true; await persist(run); return; }
      if (message.timestamp < run.startedAt || message.timestamp > Date.now() + 3000) { run.incomplete = true; await persist(run); return; }
      const reply = { hash: digest(text.trim()), timestamp: message.timestamp as number };
      if (!run.replies.some(r => r.hash === reply.hash && r.timestamp === reply.timestamp)) run.replies.push(reply);
      run.replies = run.replies.slice(-20);
      if (!pending.size && !['error', 'aborted', 'toolUse', 'tool_use', 'length'].includes(message.stopReason)) lastReply = reply;
      else if (['error', 'aborted', 'length'].includes(message.stopReason)) run.incomplete = true;
      await persist(run);
    }, ctx));
    pi.on('agent_end', (event, ctx) => serial(async () => {
      if (!run || run.execution?.state !== 'running' || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      if (event.parentToolCallId) return; // A child terminal never settles this runner's parent task.
      const ending = Array.isArray(event.messages) ? [...event.messages].reverse().find((m: any) => m.role === 'assistant') : undefined;
      if (ending && retiredReplies.has(`${ending.timestamp}:${digest(textContent(ending).trim())}`)) return;
      await check(run);
      for (const [id, captured] of pending) if (captured.task) await finish(id, captured, false, true);
      // Unfinished operations retain their persistent leases: an end event cannot prove a child/background writer stopped.
      if (pending.size) { run.incomplete = true; detachPending(); lastReply = undefined; }
      // Never refresh completed tool snapshots here: later filesystem changes belong to unknown writers.
      const messages = Array.isArray(event.messages) ? event.messages : undefined;
      if (messages) {
        const last = [...messages].reverse().find((m: any) => m.role === 'assistant');
        if (!last || !lastReply || digest(textContent(last).trim()) !== lastReply.hash || last.timestamp !== lastReply.timestamp || (Array.isArray(last.content) && last.content.some((b: any) => b.type === 'toolCall' || b.type === 'tool_use'))) lastReply = undefined;
      }
      const aborted = event.aborted === true || event.isError === true;
      if (aborted) { run.incomplete = true; lastReply = undefined; }
      if (run.boundary === 'user' && lastReply && !aborted) run.finalReply = lastReply;
      if (run.execution) run.execution = { ...run.execution, revision: run.execution.revision + 1, state: 'settled' };
      run.mainState = aborted ? 'aborted' : run.incomplete ? 'incomplete' : 'completed'; run.state = run.mainState; run.endedAt = Date.now(); await persist(run);
    }, ctx));
    pi.on('agent_settled', (_event, ctx) => serial(async () => {
      if (run?.sessionId === ctx.sessionManager.getSessionId() && run.execution?.state === 'settled') settled = true;
    }, ctx));
    pi.on('session_shutdown', (_event, ctx) => serial(async () => {
      if (run?.execution?.state === 'running') { run.incomplete = true; run.mainState = 'aborted'; run.state = 'aborted'; run.execution = { ...run.execution, revision: run.execution.revision + 1, state: 'settled' }; delete run.finalReply; run.endedAt = Date.now(); await persist(run).catch(() => {}); }
      disposed = true; detachPending(); seen.clear(); observed.clear(); run = null;
    }, ctx));
  };
}
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default createCaptureExtension({ pluginRoot });
