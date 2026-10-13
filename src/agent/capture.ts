import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CaptureRun, FileSnapshot } from '../core/contracts';
import { absentSnapshot, digest, readCapturedSnapshot, resolveCapturePath, sameSnapshot } from '../core/path-policy';
import { locatorPath, resolveLocator, SnapshotStore } from '../core/storage';
import { isImagePath } from '../core/review-file-policy';
import { beginCaptureLease, endCaptureLease, snapshotWorkspace, WORKSPACE_NOTICE, type CapturedPath } from './workspace-capture';
import { checkScratchAncestry, readCaptureContext } from '../core/capture-context';
interface Pending { run: CaptureRun; paths: CapturedPath[]; store: SnapshotStore; lease: string; name: string; workspace: boolean; complete: boolean; task: boolean; }
const toolName = (name: unknown): string => String(name).split('.').pop()!.toLowerCase();
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
  if (typeof p !== 'string' || !['write', 'edit'].includes(name)) return { targets: [], hadTargets: false, truncated: false };
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
    const waits = new Set<string>();
    let seen = new Set<string>(), retired = new Set<string>(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply: CaptureRun['finalReply'], privatePaths: string[] = [], observed = new Set<string>(), settled = false;
    const serial = (fn: () => Promise<void>, ctx: Context): Promise<void> => {
      tail = tail.then(fn).catch(async error => {
        lastReply = undefined;
        if (run) { run.incomplete = true; delete run.finalReply; await persist(run).catch(() => {}); }
        if (!warned) { warned = true; ctx.ui?.notify(`Diff view: ${error.message}`, 'warning'); }
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
      target.fileCount = Object.values(target.changes).filter(c => !c.ambiguous && !sameSnapshot(c.before, c.after)).length;
      target.contentVersion = (target.contentVersion ?? 0) + 1;
      await store!.writeRun(target, true);
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
      if (run?.state === 'running') { run.state = 'incomplete'; run.incomplete = true; delete run.finalReply; run.endedAt = Date.now(); await persist(run); }
      store = new SnapshotStore(locator.dataPath); await store.init();
      privatePaths = [await fs.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      // User-task boundary, not a model/tool-loop turn; prompts are never retained.
      await checkScratchAncestry(ctx.cwd);
      const root = await fs.realpath(ctx.cwd);
      const identity = await readCaptureContext(locator.dataPath, locator.generation, ctx.sessionManager.getSessionId(), root);
      run = { version: 2, contentVersion: 0, boundary: uncertain && !identity ? 'uncertain' : 'user', id: randomUUID(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root, startedAt: Date.now(), state: 'running', fileCount: 0, incomplete: uncertain, changes: Object.create(null), replies: [], bindings: {} };
      const userId = event?.userMessageId ?? (event?.message?.role === 'user' ? event.message.id : undefined) ?? identity?.taskId;
      if (typeof userId === 'string' && userId.length > 0 && userId.length <= 256) run.userMessageId = userId;
      if (uncertain && identity) run.notice = '运行身份已由同会话、同项目的宿主元数据核验；仅记录采集开始后的有界变更。';
      for (const id of seen) retired.add(id);
      while (retired.size > 4096) retired.delete(retired.keys().next().value!);
      pending.clear(); waits.clear(); seen.clear(); observed.clear(); warned = false; lastReply = undefined; settled = false;
      await persist(run);
    };
    pi.on('before_agent_start', (event, ctx) => serial(() => begin(ctx, false, event), ctx));
    pi.on('agent_start', (_event, ctx) => serial(async () => {
      // Desktop forwards internal end/start pairs for steering and retries without a new USER boundary.
      // Keep first-before snapshots and tool identities instead of beginning an uncertain second task.
      if (disposed || settled || !run || run.state === 'running' || run.state === 'aborted' || run.sessionId !== ctx.sessionManager.getSessionId() || run.root !== await fs.realpath(ctx.cwd)) return;
      await check(run);
      run.state = 'running'; delete run.endedAt; delete run.finalReply; delete run.cardPreview;
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
      // Workspace snapshots cannot prove which process authored a file.
      // Only explicit Write/Edit calls are eligible for turn evidence.
      if (['bash', 'shell', 'task', 'taskwait', 'task_wait'].includes(name)) return;
      const workspace = false;
      if (name === 'taskwait' || name === 'task_wait') {
        // Wait results are sampling points, not proof that every delegated task ended.
        waits.add(event.toolCallId);
        return;
      }
      if (targetSet.hadTargets && targets.length === 0 && !targetSet.truncated) return;
      if (!targets.length && !workspace) {
        if (['write', 'edit'].includes(name) || name.startsWith('plugin_')) { run.incomplete = true; await persist(run); }
        return;
      }
      const leaseStore = store!, lease = await beginCaptureLease(leaseStore, run.root, run.id, targets.slice(0, 256).map(p => path.resolve(run!.root, p)));
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
            const capture = await resolveCapturePath(run.root, target, privatePaths, name === 'write' || index > 0);
            if (!observed.has(capture.identity) && observed.size >= 256) throw new Error('Turn exceeds 256 explicitly captured files');
            observed.add(capture.identity);
            const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captured.paths.map(e => e.before));
            if (before.kind !== 'text') run.incomplete = true;
            captured.paths.push({ capture, before });
          } catch { run.incomplete = true; }
        }
      }
      await persist(run);
    }, ctx));
    const finish = async (id: string, captured: Pending, isError = false, sample = false) => {
      const target = captured.run;
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
        catch { target.incomplete = true; }
      }
      // Close only after the last read, before persistence (writeRun takes the same lock).
      const overlap = sample ? true : (await endCaptureLease(captured.store, captured.lease)) || captured.store.directory !== store!.directory;
      if (!sample) pending.delete(id);
      if (isError) target.incomplete = true;
      for (const { entry, after: rawAfter, uncertain } of pairs) {
        if (sameSnapshot(entry.before, rawAfter)) continue; // no ghost entries for no-op tools
        const priorKey = Object.keys(target.changes).find(p => target.changes[p].capture?.identity === entry.capture.identity);
        const prior = priorKey ? target.changes[priorKey] : undefined;
        if (!prior && Object.keys(target.changes).length >= 256) { target.incomplete = true; continue; }
        const ambiguous = !!(overlap || uncertain || captured.task || prior?.ambiguous || (prior && !sameSnapshot(prior.after, entry.before)));
        let before = prior?.before ?? entry.before, after = bounded(rawAfter, captured.paths.map(e => e.before));
        if (ambiguous) {
          before = { ...before, text: null, kind: 'unavailable' }; after = { ...after, text: null, kind: 'unavailable' };
          target.incomplete = true;
        }
        if (after.kind !== 'text') target.incomplete = true;
        target.changes[priorKey ?? entry.capture.path] = {
          capture: prior?.capture ?? entry.capture, before, after,
          evidence: [...(prior?.evidence ?? []), `${captured.name}:${id}`].slice(-32),
          ...(captured.workspace && !ambiguous ? { note: 'Observed workspace endpoints during a tool interval, not authoritative process-level authorship evidence.' } : {}),
          ...(ambiguous ? { ambiguous: true, note: 'Overlapping, discontinuous or delegated capture interval: file ownership is uncertain; diff and line counts unavailable.' } : {}),
        };
      }
      if (sample) {
        // Checkpoint observed endpoints so a later restoration is retained as net-zero evidence.
        captured.paths = [];
        for (const pair of pairs.slice(0, 256)) captured.paths.push({ capture: pair.entry.capture, before: bounded(pair.after) });
      }
      await persist(target);
    };
    pi.on('tool_result', (event, ctx) => serial(async () => {
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
      if (!run || run.state !== 'running' || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(run);
      for (const [id, captured] of pending) if (captured.task) await finish(id, captured, false, true);
      // Unfinished operations retain their persistent leases: an end event cannot prove a child/background writer stopped.
      if (pending.size) { run.incomplete = true; pending.clear(); lastReply = undefined; }
      // Never refresh completed tool snapshots here: later filesystem changes belong to unknown writers.
      const messages = Array.isArray(event.messages) ? event.messages : undefined;
      if (messages) {
        const last = [...messages].reverse().find((m: any) => m.role === 'assistant');
        if (!last || !lastReply || digest(textContent(last).trim()) !== lastReply.hash || last.timestamp !== lastReply.timestamp || (Array.isArray(last.content) && last.content.some((b: any) => b.type === 'toolCall' || b.type === 'tool_use'))) lastReply = undefined;
      }
      const aborted = event.aborted === true || event.isError === true;
      if (aborted) { run.incomplete = true; lastReply = undefined; }
      if (run.boundary === 'user' && lastReply && !aborted) run.finalReply = lastReply;
      run.state = aborted ? 'aborted' : run.incomplete ? 'incomplete' : 'completed'; run.endedAt = Date.now(); await persist(run);
    }, ctx));
    pi.on('agent_settled', (_event, ctx) => serial(async () => {
      if (run?.sessionId === ctx.sessionManager.getSessionId()) settled = true;
    }, ctx));
    pi.on('session_shutdown', (_event, ctx) => serial(async () => {
      if (run?.state === 'running') { run.incomplete = true; run.state = 'aborted'; delete run.finalReply; run.endedAt = Date.now(); await persist(run).catch(() => {}); }
      disposed = true; pending.clear(); seen.clear(); observed.clear(); run = null;
    }, ctx));
  };
}
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default createCaptureExtension({ pluginRoot });
