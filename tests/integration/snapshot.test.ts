import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os'; import { randomUUID } from 'node:crypto';
import { readSnapshot, snapshotOfText, absentSnapshot, digest } from '../../src/core/path-policy';
import { replaceSnapshot } from '../../src/core/rollback';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { createCaptureExtension } from '../../src/agent/capture';
let root: string, data: string, plugin: string, locator: string, generation: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-snapshot-')); data = path.join(root, 'data'); plugin = path.join(root, 'plugin'); await fs.mkdir(plugin); generation = randomUUID(); locator = path.join(root, 'locator.json'); const store = new SnapshotStore(data); await store.init(); await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: data, generation, expiresAt: Date.now()+60000 }); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function harness(sessionId = 's1') { const hooks: Record<string, Function> = {}; const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => {} } }; createCaptureExtension({ pluginRoot: plugin, locator })({ on: (event, cb) => { hooks[event] = cb; } }); return { emit: (event: string, args: unknown = {}) => hooks[event]?.(args, ctx) }; }
async function imported() { const store = new SnapshotStore(data); await store.importInbox(generation); return store.listRuns(); }
describe('snapshots and guarded restore', () => {
  it('preserves BOM bytes, permits reversible create/delete, rejects external edits', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), '\ufeff你好\r\n'); const before = await readSnapshot(root, 'a.txt'); expect(before.text).toBe('\ufeff你好\r\n');
    const after = snapshotOfText('next\r\n', before.mode); await replaceSnapshot(root, 'a.txt', before, after, path.join(data, 'backups'));
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('next\r\n');
    await fs.writeFile(path.join(root, 'a.txt'), 'user'); await expect(replaceSnapshot(root, 'a.txt', after, before, path.join(data, 'backups'))).rejects.toThrow('changed'); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('user');
    await replaceSnapshot(root, 'new.txt', absentSnapshot(), snapshotOfText('new'), path.join(data, 'backups')); const created = await readSnapshot(root, 'new.txt'); await replaceSnapshot(root, 'new.txt', created, absentSnapshot(), path.join(data, 'backups')); expect((await readSnapshot(root, 'new.txt')).exists).toBe(false);
    await replaceSnapshot(root, 'new.txt', absentSnapshot(), created, path.join(data, 'backups')); expect((await readSnapshot(root, 'new.txt')).text).toBe('new');
  });
  it('refuses symlink escape and credentials', async () => {
    await expect(readSnapshot(root, '../outside')).rejects.toThrow(); await expect(readSnapshot(root, '.env.local')).rejects.toThrow();
    await fs.symlink(data, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); await expect(readSnapshot(root, 'link/file.txt')).rejects.toThrow();
  });
  it('keeps tool calls paired and aggregates absolute/relative aliases without splitting internal turns', async () => {
    const h = harness(); await h.emit('before_agent_start', { prompt: 'private prompt' });
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 't1', input: { path: 'a.txt' } }); await fs.writeFile(path.join(root, 'a.txt'), 'first'); await h.emit('tool_result', { toolCallId: 't1', isError: false });
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 't2', input: { path: path.join(root, 'a.txt') } }); await fs.writeFile(path.join(root, 'a.txt'), 'second'); await h.emit('tool_result', { toolCallId: 't2' }); await h.emit('tool_result', { toolCallId: 't2' });
    await h.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: Date.now() } }); await h.emit('agent_end');
    const runs = await imported(); expect(runs).toHaveLength(1); expect(runs[0].fileCount).toBe(1); expect(runs[0].changes['a.txt'].before.exists).toBe(false); expect(runs[0].changes['a.txt'].after.text).toBe('second'); expect(runs[0].state).toBe('completed'); expect(runs[0].prompt).toBeUndefined(); expect(runs[0].replies[0].hash).toBe(digest('done'));
  });
  it('handles approved-plan fallback, failed tools, abort and missing blobs conservatively', async () => {
    const h = harness(); await h.emit('tool_call', { toolName: 'Write', toolCallId: 't', input: { path: 'a.txt' } }); await fs.writeFile(path.join(root, 'a.txt'), 'partial'); await h.emit('tool_result', { toolCallId: 't', isError: true }); await h.emit('session_shutdown');
    const runs = await imported(); expect(runs[0].incomplete).toBe(true); expect(runs[0].state).toBe('aborted');
    const hash = runs[0].changes['a.txt'].after.hash; await fs.unlink(path.join(data, 'blobs', hash)); const store = new SnapshotStore(data); expect((await store.getRun(runs[0].id))?.changes['a.txt'].after.kind).toBe('unavailable');
  });
  it('isolates concurrent sessions and rejects expired generations', async () => {
    const a = harness('A'), b = harness('B'); await a.emit('before_agent_start'); await b.emit('before_agent_start'); await a.emit('agent_end'); await b.emit('agent_end'); expect(new Set((await imported()).map(r => r.sessionId)).size).toBe(2);
    await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: data, generation, expiresAt: 0 }); const c = harness('C'); await c.emit('before_agent_start'); expect((await imported()).some(r => r.sessionId === 'C')).toBe(false);
  });
  it('marks a retry without a new user boundary incomplete and ignores late results', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'old', input: { path: 'a.txt' } });
    await h.emit('agent_end');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'new', input: { path: 'b.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'late'); await h.emit('tool_result', { toolCallId: 'old' });
    await fs.writeFile(path.join(root, 'b.txt'), 'new'); await h.emit('tool_result', { toolCallId: 'new' }); await h.emit('agent_end');
    const runs = await imported(); expect(runs).toHaveLength(2); expect(runs.every(r => r.incomplete)).toBe(true);
    expect(runs.find(r => r.fileCount === 1)?.changes['b.txt'].after.text).toBe('new');
    expect(runs.every(r => !r.changes['a.txt'])).toBe(true);
  });
  it('captures plan execution without a prompt, deletion and explicit moves with real before/after', async () => {
    const h = harness(); await fs.writeFile(path.join(root, 'from.txt'), 'original');
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'move', input: { path: 'from.txt', ops: 'MV to.txt' } });
    await fs.rename(path.join(root, 'from.txt'), path.join(root, 'to.txt')); await h.emit('tool_result', { toolCallId: 'move' });
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'delete', input: { path: 'to.txt', ops: 'REM' } });
    await fs.unlink(path.join(root, 'to.txt')); await h.emit('tool_result', { toolCallId: 'delete' }); await h.emit('agent_end');
    const [run] = await imported(); expect(run.incomplete).toBe(false); expect(run.changes['from.txt'].before.text).toBe('original');
    expect(run.changes['from.txt'].after.exists).toBe(false); expect(run.changes['to.txt'].before.exists).toBe(false); expect(run.changes['to.txt'].after.exists).toBe(false);
  });
  it('detects external edits between tools, duplicate calls and unsupported writers', async () => {
    const h = harness(); await h.emit('before_agent_start'); const call = { toolName: 'Write', toolCallId: 'one', input: { path: 'a.txt' } };
    await h.emit('tool_call', call); await fs.writeFile(path.join(root, 'a.txt'), 'one'); await h.emit('tool_call', call); await h.emit('tool_result', { toolCallId: 'one' });
    await fs.writeFile(path.join(root, 'a.txt'), 'external'); await h.emit('tool_call', { ...call, toolCallId: 'two' }); await fs.writeFile(path.join(root, 'a.txt'), 'two'); await h.emit('tool_result', { toolCallId: 'two' });
    await h.emit('tool_call', { toolName: 'Bash', toolCallId: 'bash', input: {} }); await h.emit('agent_end');
    const [run] = await imported(); expect(run.incomplete).toBe(true); expect(run.changes['a.txt'].before.exists).toBe(false); expect(run.changes['a.txt'].after.text).toBe('two');
  });
  it('imports old-generation running captures as incomplete and preserves main-owned bindings', async () => {
    const h = harness(); await h.emit('before_agent_start'); await h.emit('tool_call', { toolName: 'Write', toolCallId: 'a', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'a'); await h.emit('tool_result', { toolCallId: 'a' });
    const store = new SnapshotStore(data); await store.importInbox(generation); const [run] = await store.listRuns(); run.bindings.reply = 'message'; await store.writeRun(run);
    await store.importInbox(generation); expect((await store.getRun(run.id))?.bindings.reply).toBe('message');
    await store.importInbox(randomUUID()); expect((await store.getRun(run.id))?.state).toBe('incomplete');
    const reopened = new SnapshotStore(data); expect((await reopened.getRun(run.id))?.changes['a.txt'].after.text).toBe('a');
  });
});
