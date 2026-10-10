import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CaptureIdentity, CaptureRun, FileSnapshot } from '../core/contracts';
import { digest, readCapturedSnapshot, resolveCapturePath, sameSnapshot } from '../core/path-policy';
import { locatorPath, resolveLocator, SnapshotStore } from '../core/storage';
interface Context { cwd: string; sessionManager: { getSessionId(): string }; ui?: { notify(message: string, level?: string): void }; }
interface Extension { on(event: string, handler: (event: any, ctx: Context) => unknown): void; }
interface Options { pluginRoot: string; locator?: string; }
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
function textContent(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
}
function toolPaths(name: string, input: any): string[] {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== 'string' || !['Write', 'Edit', 'write', 'edit'].includes(name)) return [];
  const paths = [p];
  if (/^edit$/i.test(name) && typeof input.ops === 'string') for (const line of input.ops.split('\n')) if (line.startsWith('MV ')) { paths.push(line.slice(3).trim()); if (paths.length > 256) break; }
  return [...new Set(paths)];
}
/** One closure per runner; no filesystem discovery and no replacement tool results. */
export function createCaptureExtension(options: Options): (pi: Extension) => void {
  return pi => {
    let run: CaptureRun | null = null, store: SnapshotStore | null = null;
    let pending = new Map<string, { run: CaptureRun; paths: { capture: CaptureIdentity; before: FileSnapshot }[] }>();
    let seen = new Set<string>(), retired = new Set<string>(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply: CaptureRun['finalReply'], privatePaths: string[] = [], observed = new Set<string>();
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
      if (locator.generation !== target.generation) throw new Error('Capture generation changed; reload the Agent session');
      return locator;
    };
    const persist = async (target: CaptureRun) => {
      await check(target);
      target.fileCount = Object.values(target.changes).filter(c => !sameSnapshot(c.before, c.after)).length;
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
    const begin = async (ctx: Context, uncertain = false) => {
      if (disposed) return;
      const locator = await bridge();
      if (run?.state === 'running') { run.state = 'incomplete'; run.incomplete = true; delete run.finalReply; run.endedAt = Date.now(); await persist(run); }
      store = new SnapshotStore(locator.dataPath); await store.init();
      privatePaths = [await fs.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      // User-task boundary, not a model/tool-loop turn; prompts are never retained.
      run = { version: 2, contentVersion: 0, boundary: uncertain ? 'uncertain' : 'user', id: randomUUID(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root: await fs.realpath(ctx.cwd), startedAt: Date.now(), state: 'running', fileCount: 0, incomplete: uncertain, changes: Object.create(null), replies: [], bindings: {} };
      for (const id of seen) retired.add(id);
      while (retired.size > 4096) retired.delete(retired.keys().next().value!);
      pending.clear(); seen.clear(); observed.clear(); warned = false; lastReply = undefined;
      await persist(run);
    };
    pi.on('before_agent_start', (_event, ctx) => serial(() => begin(ctx), ctx));
    pi.on('tool_call', (event, ctx) => serial(async () => {
      if (disposed || typeof event.toolCallId !== 'string' || seen.has(event.toolCallId)) return;
      lastReply = undefined;
      if (!run || run.state !== 'running') await begin(ctx, true);
      if (!run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      if (retired.has(event.toolCallId)) { if (run) { run.incomplete = true; await persist(run); } return; }
      if (seen.size >= 4096 || pending.size >= 256 || event.toolCallId.length > 256) { run.incomplete = true; await persist(run); return; }
      await check(run); seen.add(event.toolCallId);
      const name = String(event.toolName), targets = toolPaths(name, event.input ?? event.args);
      if (!targets.length) {
        if (/^(Bash|bash|Task|task|Write|write|Edit|edit)$/.test(name) || name.startsWith('plugin_')) { run.incomplete = true; await persist(run); }
        return;
      }
      if (targets.length > 256) run.incomplete = true;
      const captures: { capture: CaptureIdentity; before: FileSnapshot }[] = [];
      for (const [index, target] of targets.slice(0, 256).entries()) {
        try {
          const capture = await resolveCapturePath(run.root, target, privatePaths, /^write$/i.test(name) || index > 0);
          if (!observed.has(capture.identity) && observed.size >= 256) throw new Error('Turn exceeds 256 explicitly captured files');
          observed.add(capture.identity);
          const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captures.map(e => e.before));
          if (before.kind !== 'text') run.incomplete = true;
          captures.push({ capture, before });
        } catch { run.incomplete = true; }
      }
      pending.set(event.toolCallId, { run, paths: captures });
      await persist(run);
    }, ctx));
    pi.on('tool_result', (event, ctx) => serial(async () => {
      const captured = pending.get(event.toolCallId);
      if (!captured || disposed) return;
      pending.delete(event.toolCallId);
      const target = captured.run;
      if (target !== run || target.state !== 'running' || target.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(target);
      lastReply = undefined;
      for (const entry of captured.paths) {
        try {
          const after = bounded(await readCapturedSnapshot(target.root, entry.capture, privatePaths), captured.paths.map(e => e.before));
          if (event.isError || after.kind !== 'text') target.incomplete = true;
          const priorKey = Object.keys(target.changes).find(p => target.changes[p].capture?.identity === entry.capture.identity);
          const prior = priorKey ? target.changes[priorKey] : undefined;
          if (prior && !sameSnapshot(prior.after, entry.before)) target.incomplete = true;
          target.changes[priorKey ?? entry.capture.path] = { capture: prior?.capture ?? entry.capture, before: prior?.before ?? entry.before, after };
        } catch { target.incomplete = true; }
      }
      await persist(target);
      return undefined;
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
      const reply = { hash: digest(text), timestamp: message.timestamp as number };
      if (!run.replies.some(r => r.hash === reply.hash && r.timestamp === reply.timestamp)) run.replies.push(reply);
      run.replies = run.replies.slice(-20);
      if (!pending.size && !['error', 'aborted', 'toolUse', 'tool_use', 'length'].includes(message.stopReason)) lastReply = reply;
      else if (['error', 'aborted', 'length'].includes(message.stopReason)) run.incomplete = true;
      await persist(run);
    }, ctx));
    pi.on('agent_end', (event, ctx) => serial(async () => {
      if (!run || run.state !== 'running' || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(run);
      if (pending.size) { run.incomplete = true; pending.clear(); lastReply = undefined; }
      // Read only the exact authorized paths again; never infer changes from Git or a directory.
      for (const change of Object.values(run.changes)) if (change.capture) {
        try {
          const after = bounded(await readCapturedSnapshot(run.root, change.capture, privatePaths));
          if (!sameSnapshot(change.after, after)) run.incomplete = true;
          change.after = after;
        } catch { run.incomplete = true; change.after = { ...change.after, kind: 'unavailable', text: null }; }
      }
      const messages = Array.isArray(event.messages) ? event.messages : undefined;
      if (messages) {
        const last = [...messages].reverse().find((m: any) => m.role === 'assistant');
        if (!last || !lastReply || digest(textContent(last)) !== lastReply.hash || last.timestamp !== lastReply.timestamp || (Array.isArray(last.content) && last.content.some((b: any) => b.type === 'toolCall' || b.type === 'tool_use'))) lastReply = undefined;
      }
      const aborted = event.aborted === true || event.isError === true;
      if (aborted) { run.incomplete = true; lastReply = undefined; }
      if (run.boundary === 'user' && lastReply && !aborted) run.finalReply = lastReply;
      run.state = aborted ? 'aborted' : run.incomplete ? 'incomplete' : 'completed'; run.endedAt = Date.now(); await persist(run);
    }, ctx));
    pi.on('session_shutdown', (_event, ctx) => serial(async () => {
      if (run?.state === 'running') { run.incomplete = true; run.state = 'aborted'; delete run.finalReply; run.endedAt = Date.now(); await persist(run).catch(() => {}); }
      disposed = true; pending.clear(); seen.clear(); observed.clear(); run = null;
    }, ctx));
  };
}
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default createCaptureExtension({ pluginRoot });
