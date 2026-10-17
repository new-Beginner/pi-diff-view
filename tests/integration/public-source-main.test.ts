import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { createCaptureExtension } from '../../src/agent/capture';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture() {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'public-source-main-'));
  const root = path.join(temp, 'project'), data = path.join(temp, 'host/plugins/data/local.diff-view');
  await fs.mkdir(root); const pluginRoot = path.join(temp, 'plugin'); await fs.mkdir(pluginRoot); const entry = path.join(pluginRoot, 'main.cjs');
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true });
  const previous = (globalThis as any).pi; vi.spyOn(os, 'homedir').mockReturnValue(temp);
  const since = Date.now() - 1000;
  const messages: any[] = [{ id: 'u', role: 'user', createdAt: since, content: 'PRIVATE USER PROSE' }];
  let running = true, denied = false, truncated = false;
  const desktop = {
    listOperations: vi.fn(async () => [{ id: 'agent/getStatus', risk: 'read', description: 'Status' }, { id: 'session/get', risk: 'read', description: 'Session' }]),
    invoke: vi.fn(async ({ operation, args }: any) => {
      if (denied) throw Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' });
      if (operation === 'agent/getStatus') return { status: { sessionId: args[0], isRunning: running, currentTurnId: 'native-turn' } };
      if (operation === 'session/get') return { session: { id: args[0].id, projectPath: root, messages, messageStart: 0, messageEnd: messages.length, hasMoreBefore: false, ...(truncated ? { truncated: true } : {}) } };
      throw new Error('Unexpected desktop operation');
    }),
  };
  const listeners = new Map<string, (event: any) => void>();
  (globalThis as any).pi = {
    desktop, plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => ({ path: root }) },
    app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on(name: string, handler: (event: any) => void) { listeners.set(name, handler); }, off(name: string) { listeners.delete(name); } },
  };
  const plugin = createRequire(import.meta.url)(entry); await plugin.onLoad();
  cleanups.push(async () => { await plugin.onUnload(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); });
  return { plugin, root, temp, pluginRoot, data, messages, since, desktop, settle() { running = false; }, deny() { denied = true; }, truncate() { truncated = true; }, ended() { listeners.get('session:turnEnded')?.({ sessionId: 's', turnId: 'native-turn', reason: 'stop' }); } };
}
it('reconciles plugin-owned Agent snapshots by exact public tool IDs without reading private host history', async () => {
  const f = await fixture(), file = path.join(f.root, 'file.txt'); await fs.writeFile(file, 'old\n');
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  createCaptureExtension({ pluginRoot: f.pluginRoot })({ on(name, handler) { handlers[name] = handler; } });
  const ctx = { cwd: f.root, sessionManager: { getSessionId: () => 's' } };
  const event = (name: string, value: any = {}) => handlers[name](value, ctx);
  await event('before_agent_start', { prompt: 'PRIVATE USER PROSE' });
  await event('tool_call', { toolCallId: 'call', toolName: 'Edit', input: { path: file, old_string: 'old', new_string: 'new' } });
  await fs.writeFile(file, 'new\n'); await event('tool_result', { toolCallId: 'call', toolName: 'Edit' });
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE ASSISTANT PROSE' }], timestamp: Date.now(), stopReason: 'stop' };
  await event('message_end', { message: reply }); await event('agent_end', { messages: [reply] });
  f.messages.push({ id: 'tool', role: 'tool', createdAt: Date.now(), toolCallId: 'call', toolName: 'Edit', toolArgs: { path: file, old_string: 'old', new_string: 'new' }, toolStatus: 'success' }, { id: 'reply', role: 'assistant', createdAt: Date.now() + 1, status: 'complete', content: 'PRIVATE ASSISTANT PROSE' });
  f.settle(); const reads = vi.spyOn(fs, 'readFile');
  await f.plugin.onRendererCall('sessionContext', { sessionId: 's', root: f.root, running: true, taskId: 'forged', since: 1 });
  const store = new SnapshotStore(f.data), runs = await store.listRuns();
  expect(runs.filter(run => run.sessionId === 's')).toHaveLength(1);
  const run = await store.getRun(runs[0].id);
  expect(run).toMatchObject({ userMessageId: 'u', replyMessageId: 'reply', state: 'completed', fileCount: 1 });
  expect(run?.changes['file.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' } });
  expect(reads.mock.calls.some(([name]) => /host[\\/]sessions|host[\\/]review-changes/.test(String(name)))).toBe(false);
  const context = JSON.parse(await fs.readFile(path.join(f.data, 'capture-contexts.json'), 'utf8'));
  expect(JSON.stringify(context)).not.toContain('forged');
  const state = await f.plugin.onRendererCall('sessionState', { sessionId: 's' });
  expect(state).toMatchObject({ sessionId: 's', running: false, statusKnown: true });
  expect(JSON.stringify(state)).not.toContain('PRIVATE'); expect(state).not.toHaveProperty('messages');
  await expect(f.plugin.onRendererCall('sessionEvidence', {})).rejects.toThrow(/backend public source/);
  expect(f.desktop.invoke.mock.calls.every(([input]) => ['agent/getStatus', 'session/get'].includes(input.operation))).toBe(true);
});
it('keeps denied public status unknown and rejects invalid session IDs', async () => {
  const f = await fixture(); f.deny();
  expect(await f.plugin.onRendererCall('sessionState', { sessionId: 's' })).toMatchObject({ sessionId: 's', statusKnown: false, running: false });
  await expect(f.plugin.onRendererCall('sessionState', { sessionId: '../private' })).rejects.toThrow(/Invalid session/);
});
it('keeps independently verified public activity when transcript content is truncated', async () => {
  const f = await fixture(); f.truncate();
  f.messages.push({ id: 'write', role: 'tool', createdAt: f.since + 1, toolCallId: 'write', toolName: 'Write', toolStatus: 'success', toolArgs: { path: 'a.txt', content: 'new\n' }, toolResult: { details: { review: { version: 1, path: 'a.txt', messageId: 'write', status: 'added' } } } });
  await f.plugin.onRendererCall('sessionContext', { sessionId: 's' });
  const store = new SnapshotStore(f.data);
  expect((await store.listRuns(false, true))[0]).toMatchObject({ state: 'running', userMessageId: 'u' });
  const state = await f.plugin.onRendererCall('sessionState', { sessionId: 's' });
  expect(state).toMatchObject({ statusKnown: true, running: true, taskId: 'u' });
});
it('invalidates pre-completion public status when the official turn-ended event arrives', async () => {
  const f = await fixture();
  f.messages.push({ id: 'write', role: 'tool', createdAt: f.since + 1, toolCallId: 'write', toolName: 'Write', toolStatus: 'success', toolArgs: { path: 'a.txt', content: 'new\n' }, toolResult: { details: { review: { version: 1, path: 'a.txt', messageId: 'write', status: 'added' } } } });
  await f.plugin.onRendererCall('sessionContext', { sessionId: 's' });
  const store = new SnapshotStore(f.data);
  expect((await store.listRuns(false, true))[0].state).toBe('running');
  f.settle(); f.messages.push({ id: 'final', role: 'assistant', createdAt: Date.now(), status: 'complete', content: 'done' });
  f.ended();
  await expect.poll(async () => (await store.listRuns(false, true))[0]?.state).toBe('completed');
  expect(await f.plugin.onRendererCall('sessionState', { sessionId: 's' })).toMatchObject({ statusKnown: true, running: false });
});
