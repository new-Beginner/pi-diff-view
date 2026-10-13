import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCaptureExtension } from '../../src/agent/capture';
import { snapshotWorkspace, beginCaptureLease, endCaptureLease } from '../../src/agent/workspace-capture';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { canonical, sameSnapshot } from '../../src/core/path-policy';

let fixture: string, root: string, virtualRoot: string, plugin: string, locator: string, generation: string, store: SnapshotStore;
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'expanded-capture-'));
  root = path.join(fixture, 'workspace'); plugin = path.join(fixture, 'plugin'); locator = path.join(fixture, 'locator.json');
  await fs.mkdir(root); await fs.mkdir(plugin);
  generation = randomUUID(); store = new SnapshotStore(path.join(fixture, 'data')); await store.init();
  await publish();
  // Only virtual public prefixes bypass the private scratch ancestor; all actual IO stays in scratch.
  virtualRoot = path.join(path.parse(root).root, `capture-fixture-${randomUUID()}`);
  const aliased = (p: any) => typeof p === 'string' && (canonical(p) === canonical(virtualRoot) || canonical(p).startsWith(canonical(virtualRoot) + path.sep));
  const map = (p: any) => aliased(p) ? path.join(root, path.relative(virtualRoot, p)) : p;
  const lstat = fs.lstat.bind(fs), realpath = fs.realpath.bind(fs), open = fs.open.bind(fs), opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((p: any, opts?: any) => lstat(map(p), opts) as any);
  vi.spyOn(fs, 'realpath').mockImplementation(async (p: any) => {
    const resolved = await realpath(map(p)); return aliased(p) ? path.join(virtualRoot, path.relative(root, resolved)) : resolved;
  });
  vi.spyOn(fs, 'open').mockImplementation((p: any, flags: any, mode?: any) => open(map(p), flags, mode));
  vi.spyOn(fs, 'opendir').mockImplementation((p: any, opts?: any) => opendir(map(p), opts));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture, { recursive: true, force: true }); });
async function publish() { await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 }); }
function harness(session = 's') {
  const hooks: Record<string, Function> = {}, ctx = { cwd: virtualRoot, sessionManager: { getSessionId: () => session }, ui: { notify: vi.fn() } };
  createCaptureExtension({ pluginRoot: plugin, locator })({ on: (event, handler) => { hooks[event] = handler; } });
  return { emit: (event: string, args: any = {}) => hooks[event]?.(args, ctx), ctx };
}
async function runs() { await store.importInbox(generation); return store.listRuns(); }
const write = (file: string, text: string | Uint8Array) => fs.writeFile(path.join(root, file), text);
async function call(h: ReturnType<typeof harness>, name: string, id: string, work: () => Promise<unknown>, input: any = {}) {
  await h.emit('tool_call', { toolName: name, toolCallId: id, input }); await work(); await h.emit('tool_result', { toolCallId: id });
}

describe('expanded live capture without Git or project command execution', () => {
  it.each(['functions.Bash', 'Shell'])('does not record %s filesystem effects', async name => {
    await write('edit.txt', 'old');
    const h = harness(); await h.emit('before_agent_start', { userMessageId: 'host-user-42' });
    await call(h, name, 'shell', async () => { await write('edit.txt', 'new'); await write('binary.dat', new Uint8Array([0, 255, 1])); }, { command: 'not executed or interpreted by capture' });
    await h.emit('agent_end'); const [run] = await runs();
    expect(await runs()).toEqual([]);
  });
  it('ignores explicit image-file writes while retaining ordinary text changes', async () => {
    await write('render.PNG', 'before'); await write('graphic.SVG', 'before'); await write('notes.txt', 'before');
    const h = harness(); await h.emit('before_agent_start');
    await call(h, 'functions.Write', 'png', () => write('render.PNG', 'after'), { path: 'render.PNG' });
    await call(h, 'functions.Edit', 'svg', () => write('graphic.SVG', 'after'), { path: 'graphic.SVG' });
    await call(h, 'functions.Edit', 'text', () => write('notes.txt', 'after'), { path: 'notes.txt', ops: Array.from({ length: 300 }, (_, index) => `MV image-${index}.PNG`).join('\n') });
    await h.emit('agent_end'); const [run] = await runs();
    expect(Object.keys(run.changes)).toEqual(['notes.txt']); expect(run.fileCount).toBe(1); expect(run.incomplete).toBe(false);
  });
  it('keeps observed changed-then-restored evidence but omits unchanged file-tool ghosts', async () => {
    const h = harness(); await write('a.txt', 'before'); await h.emit('before_agent_start');
    await call(h, 'functions.Edit', 'noop', async () => {}, { path: 'a.txt' }); expect(await runs()).toEqual([]);
    await call(h, 'functions.Edit', 'edit', () => write('a.txt', 'after'), { path: 'a.txt' });
    await call(h, 'functions.Write', 'restore', () => write('a.txt', 'before'), { path: 'a.txt' });
    await h.emit('agent_end'); const [run] = await runs();
    expect(sameSnapshot(run.changes['a.txt'].before, run.changes['a.txt'].after)).toBe(true);
    expect(run.changes['a.txt'].evidence).toEqual(['edit:edit', 'write:restore']); expect(run.userMessageId).toBeUndefined();
  });
  it('does not retain shell create-delete endpoint evidence', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await call(h, 'Bash', 'create', () => write('a.txt', 'one'));
    await call(h, 'Bash', 'remove', () => fs.unlink(path.join(root, 'a.txt')));
    await h.emit('agent_end'); const [run] = await runs();
    expect(await runs()).toEqual([]);
  });
  it('does not replace completed tool snapshots with unrelated agent_end modifications', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await call(h, 'functions.Write', 'write', () => write('a.txt', 'owned'), { path: 'a.txt' });
    await write('a.txt', 'external later'); await h.emit('agent_end');
    expect((await runs())[0].changes['a.txt'].after.text).toBe('owned');
  });
  it('does not let an overlapping shell interval taint an explicit Write capture', async () => {
    const a = harness('a'), b = harness('b'); await a.emit('before_agent_start'); await b.emit('before_agent_start');
    await a.emit('tool_call', { toolName: 'Bash', toolCallId: 'a' });
    await b.emit('tool_call', { toolName: 'Write', toolCallId: 'b', input: { path: 'shared.txt' } });
    await write('shared.txt', 'written'); await b.emit('tool_result', { toolCallId: 'b' }); await a.emit('tool_result', { toolCallId: 'a' });
    await a.emit('agent_end'); await b.emit('agent_end');
    const captured = await runs(); expect(captured).toHaveLength(1);
    expect(captured[0].changes['shared.txt'].after).toMatchObject({ kind: 'text', text: 'written' });
  });
  it('marks independent overlapping operations in the same runner ambiguous', async () => {
    const h = harness(); await h.emit('before_agent_start');
    for (const id of ['one', 'two']) await h.emit('tool_call', { toolName: 'Write', toolCallId: id, input: { path: 'a.txt' } });
    await write('a.txt', 'one'); await h.emit('tool_result', { toolCallId: 'one' });
    await write('a.txt', 'two'); await h.emit('tool_result', { toolCallId: 'two' }); await h.emit('agent_end');
    expect((await runs())[0].changes['a.txt'].ambiguous).toBe(true);
  });
  it('retains text for parallel explicit tools on different files in one project', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'a', input: { path: 'a.txt' } });
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'b', input: { path: 'b.txt' } });
    await write('a.txt', 'first'); await write('b.txt', 'second');
    await h.emit('tool_result', { toolCallId: 'a' }); await h.emit('tool_result', { toolCallId: 'b' });
    await h.emit('agent_end'); const [run] = await runs();
    expect(run.changes['a.txt'].after).toMatchObject({ kind: 'text', text: 'first' });
    expect(run.changes['b.txt'].after).toMatchObject({ kind: 'text', text: 'second' });
    expect(Object.values(run.changes).some(change => change.ambiguous)).toBe(false);
  });
  it('persists unresolved leases across store instances and covers explicit external scopes', async () => {
    const lease = await beginCaptureLease(store, '/root-a', 'a', ['/shared/file']);
    const otherStore = new SnapshotStore(store.directory);
    const other = await beginCaptureLease(otherStore, '/root-b', 'b', ['/shared/file']);
    expect(await endCaptureLease(otherStore, other)).toBe(true); expect(await endCaptureLease(store, lease)).toBe(true);
    const clean = await beginCaptureLease(store, '/root-a', 'c'); expect(await endCaptureLease(store, clean)).toBe(false);
  });
  it('does not record Task or TaskWait filesystem effects', async () => {
    await write('child.txt', 'before'); const h = harness(); await h.emit('before_agent_start');
    await call(h, 'functions.Task', 'launch', async () => {});
    await write('child.txt', 'child wrote'); await call(h, 'functions.TaskWait', 'wait', async () => {});
    await write('child.txt', 'before'); await h.emit('agent_end'); const [ended] = await runs();
    expect(await runs()).toEqual([]);
  });
  it('recovers trusted locator generation without discarding the current user task', async () => {
    const h = harness(); await h.emit('before_agent_start', { message: { role: 'user', id: 'stable-id' } });
    await call(h, 'Write', 'first', () => write('a.txt', 'first'), { path: 'a.txt' }); const [initial] = await runs();
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'delayed', input: { path: 'a.txt' } });
    generation = randomUUID(); await publish(); await write('a.txt', 'second'); await h.emit('tool_result', { toolCallId: 'delayed' });
    await call(h, 'Write', 'next', () => write('next.txt', 'next'), { path: 'next.txt' }); await h.emit('agent_end');
    const captured = await runs(), current = captured.find(r => r.id === initial.id)!;
    expect(current.generation).toBe(generation); expect(current.userMessageId).toBe('stable-id');
    expect(current.changes['a.txt'].before.exists).toBe(false); expect(current.changes['a.txt'].after.text).toBe('second');
    expect(current.changes['next.txt'].after.text).toBe('next');
  });
  it('excludes credentials, dependencies, private paths and symlinks before content reads', async () => {
    await write('.env', 'secret'); await write('secret.pem', 'secret'); await write('public.txt', 'public');
    await write('Photo.PNG', 'pixel bytes'); await write('vector.SvG', '<svg/>'); await write('opaque.dat', new Uint8Array([0, 255, 1]));
    await fs.mkdir(path.join(root, 'node_modules')); await write('node_modules/private.txt', 'secret');
    await fs.mkdir(path.join(root, 'private')); await write('private/internal.txt', 'secret');
    await fs.symlink(path.join(root, 'private'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const snapshot = await snapshotWorkspace(virtualRoot, [path.join(virtualRoot, 'private')]);
    expect(snapshot.paths.map(e => e.capture.path).sort()).toEqual(['opaque.dat', 'public.txt']);
    expect(snapshot.notice).toContain('credentials');
  });
  it('captures root lockfiles before a large nested directory exhausts the scan', async () => {
    await fs.mkdir(path.join(root, 'aaa-nested'));
    for (let i = 0; i < 260; i++) await write(`aaa-nested/file-${i}.txt`, 'nested');
    await write('package-lock.json', 'root-lock');
    const snapshot = await snapshotWorkspace(virtualRoot, []);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.paths.find(entry => entry.capture.path === 'package-lock.json')?.before.text).toBe('root-lock');
  });
  it('bounds discovered files and visibly reports truncation', async () => {
    for (let i = 0; i < 260; i++) await write(`file-${i}.txt`, 'small');
    const snapshot = await snapshotWorkspace(virtualRoot, []);
    expect(snapshot.paths).toHaveLength(256); expect(snapshot.complete).toBe(false); expect(snapshot.notice).toContain('4096');
  });
});
