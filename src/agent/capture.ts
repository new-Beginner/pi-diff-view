import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CaptureRun, FileSnapshot } from '../core/contracts';
import { canonical, digest, readSnapshot, sameSnapshot, safeResolve } from '../core/path-policy';
import { locatorPath, resolveLocator, SnapshotStore } from '../core/storage';
interface Context { cwd: string; sessionManager: { getSessionId(): string }; ui?: { notify(message: string, level?: string): void }; }
interface Extension { on(event: string, handler: (event: any, ctx: Context) => unknown): void; }
interface Options { pluginRoot: string; locator?: string; }
function textContent(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
}
function toolPaths(name: string, input: any): string[] {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== 'string' || !['Write', 'Edit', 'write', 'edit'].includes(name)) return [];
  const paths = [p];
  if (typeof input.ops === 'string') for (const line of input.ops.split('\n')) if (line.startsWith('MV ')) paths.push(line.slice(3).trim());
  return [...new Set(paths)];
}
/** One closure per runner, no process-global session state. All writes serialize. */
export function createCaptureExtension(options: Options): (pi: Extension) => void {
  return pi => {
    let run: CaptureRun | null = null, store: SnapshotStore | null = null;
    let pending = new Map<string, { run: CaptureRun; paths: { path: string; before: FileSnapshot }[] }>();
    let seen = new Set<string>(), warned = false, disposed = false, tail = Promise.resolve();
    const serial = (fn: () => Promise<void>, ctx: Context): Promise<void> => {
      tail = tail.then(fn).catch(error => { if (run) run.incomplete = true; if (!warned) { warned = true; ctx.ui?.notify(`Diff view: ${error.message}`, 'warning'); } });
      return tail;
    };
    const bridge = async () => {
      const file = options.locator ?? await locatorPath(options.pluginRoot);
      return resolveLocator(file, options.pluginRoot);
    };
    const persist = async (target: CaptureRun) => {
      const locator = await bridge();
      if (locator.generation !== target.generation) throw new Error('Capture generation changed; reload the Agent session');
      target.fileCount = Object.keys(target.changes).length;
      await store!.writeRun(target, true);
    };
    const begin = async (ctx: Context, prompt?: string, uncertain = false) => {
      if (disposed) return;
      const locator = await bridge();
      store = new SnapshotStore(locator.dataPath); await store.init();
      if (run && (run.state === 'running' || uncertain)) { run.state = 'incomplete'; run.incomplete = true; run.endedAt = Date.now(); await persist(run); }
      // Do not retain raw user prompts in the snapshot store.
      run = { version: 1, id: randomUUID(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root: await fs.realpath(ctx.cwd), startedAt: Date.now(), state: 'running', fileCount: 0, incomplete: uncertain, changes: {}, replies: [], bindings: {} };
      pending = new Map(); seen = new Set(); warned = false;
      void prompt; await persist(run);
    };
    pi.on('before_agent_start', (event, ctx) => serial(() => begin(ctx, event.prompt), ctx));
    pi.on('tool_call', (event, ctx) => serial(async () => {
      if (disposed || seen.has(event.toolCallId)) return;
      if (!run || run.state !== 'running') await begin(ctx, undefined, run !== null);
      if (!run) return;
      const name = String(event.toolName), inputs = event.input ?? event.args;
      const targets = toolPaths(name, inputs);
      if (!targets.length) {
        if (/^(Bash|bash|Task|task)$/.test(name) || name.startsWith('plugin_')) { run.incomplete = true; await persist(run); }
        return;
      }
      const captures: { path: string; before: FileSnapshot }[] = [];
      for (const target of targets) {
        try {
          const abs = await safeResolve(run.root, target);
          const rel = path.relative(run.root, abs).split(path.sep).join('/');
          const before = await readSnapshot(run.root, rel);
          if (before.kind !== 'text') run.incomplete = true;
          captures.push({ path: rel, before });
        } catch { run.incomplete = true; }
      }
      seen.add(event.toolCallId);
      pending.set(event.toolCallId, { run, paths: captures });
      await persist(run);
    }, ctx));
    pi.on('tool_result', (event, ctx) => serial(async () => {
      const captured = pending.get(event.toolCallId);
      if (!captured || disposed) return;
      pending.delete(event.toolCallId);
      const target = captured.run;
      for (const entry of captured.paths) {
        try {
          const after = await readSnapshot(target.root, entry.path);
          if (event.isError || after.kind !== 'text') target.incomplete = true;
          if (sameSnapshot(entry.before, after)) continue;
          const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
          const prior = Object.keys(target.changes).find(p => (process.platform === 'win32' ? p.toLowerCase() : p) === key);
          if (prior && !sameSnapshot(target.changes[prior].after, entry.before)) target.incomplete = true;
          target.changes[prior ?? entry.path] = { before: prior ? target.changes[prior].before : entry.before, after };
        } catch { target.incomplete = true; }
      }
      await persist(target);
      return undefined; // Never replace the original tool result.
    }, ctx));
    pi.on('message_end', (event, ctx) => serial(async () => {
      if (!run || event.message?.role !== 'assistant') return;
      const message = event.message;
      if (Array.isArray(message.content) && message.content.some((b: any) => b.type === 'toolCall')) return;
      const text = textContent(message); if (!text.trim()) return;
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
      const hash = digest(text);
      if (!run.replies.some(r => r.hash === hash && r.timestamp === timestamp)) run.replies.push({ hash, timestamp });
      run.replies = run.replies.slice(-20); await persist(run);
    }, ctx));
    pi.on('agent_end', (_event, ctx) => serial(async () => {
      if (!run) return;
      if (pending.size) { run.incomplete = true; pending.clear(); }
      run.state = run.incomplete ? 'incomplete' : 'completed'; run.endedAt = Date.now(); await persist(run);
    }, ctx));
    pi.on('session_shutdown', (_event, ctx) => serial(async () => {
      if (run?.state === 'running') { run.incomplete = true; run.state = 'aborted'; run.endedAt = Date.now(); await persist(run).catch(() => {}); }
      disposed = true; pending.clear(); seen.clear(); run = null;
    }, ctx));
    // A delayed result stays bound to its captured run, never whichever run is current.
    void canonical;
  };
}
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default createCaptureExtension({ pluginRoot });
