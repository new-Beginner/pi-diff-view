import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCaptureExtension } from '../../src/agent/capture';
import { snapshotWorkspace } from '../../src/agent/workspace-capture';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { checkScratchAncestry, writeCaptureContexts } from '../../src/core/capture-context';
import { absentSnapshot, canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import { capturedChange, expirePublicCache, publicDesktopFixture, seedCapture, unavailableText, type PublicSessionFixture } from '../helpers/public-desktop-fixture';

const temporary = () => fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'no-workspace-'));
it('captures real scratch Write/Edit and explicit external tools, with trusted running identity and private-path exclusions', async () => {
  const temp = await temporary(), sid = randomUUID(), generation = randomUUID();
  const host = path.join(temp, '.pi-desktoooop', 'data'), root = path.join(host, 'scratch', sid), plugin = path.join(temp, 'plugin'), locator = path.join(temp, 'locator.json');
  const store = new SnapshotStore(path.join(host, 'plugins', 'data', 'diff-view'));
  try {
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(plugin); await store.init();
    await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 });
    await writeCaptureContexts(store.directory, generation, [{ sessionId: sid, root, running: true, taskId: 'user-one', since: Date.now() - 100, updatedAt: Date.now() }]);
    const hooks: Record<string, Function> = {}, ctx = { cwd: root, sessionManager: { getSessionId: () => sid }, ui: { notify: vi.fn() } };
    createCaptureExtension({ pluginRoot: plugin, locator })({ on: (event, handler) => { hooks[event] = handler; } });
    const emit = (event: string, args: any = {}) => hooks[event]?.(args, ctx);
    const file = path.join(root, 'nested', 'notes.txt'), external = path.join(temp, 'external.txt');
    await emit('tool_call', { toolName: 'functions.Write', toolCallId: 'write', input: { file_path: file, content: 'first\n' } });
    await fs.mkdir(path.dirname(file)); await fs.writeFile(file, 'first\n'); await emit('tool_result', { toolCallId: 'write' });
    await emit('tool_call', { toolName: 'functions.Edit', toolCallId: 'edit', input: { path: file, ops: 'PUT 1.=1:\n+second' } });
    await fs.writeFile(file, 'second\n'); await emit('tool_result', { toolCallId: 'edit' });
    await emit('tool_call', { toolName: 'Write', toolCallId: 'external', input: { path: external } });
    await fs.writeFile(external, 'outside\n'); await emit('tool_result', { toolCallId: 'external' });
    for (const target of [path.join(root, '.env'), path.join(store.directory, 'private.txt')]) {
      await emit('tool_call', { toolName: 'Write', toolCallId: `private-${path.basename(target)}`, input: { path: target } });
      await fs.writeFile(target, 'secret'); await emit('tool_result', { toolCallId: `private-${path.basename(target)}` });
    }
    const snapshot = await snapshotWorkspace(root, [store.directory, plugin]);
    expect(snapshot.paths.map(p => p.capture.path)).toEqual(['nested/notes.txt']);
    await fs.writeFile(file, 'unrelated later\n'); await emit('agent_end'); await store.importInbox(generation);
    const [run] = await store.listRuns();
    expect(run).toMatchObject({ root, sessionId: sid, boundary: 'user', userMessageId: 'user-one', fileCount: 2 });
    expect(run.changes['nested/notes.txt']).toMatchObject({ before: { exists: false }, after: { text: 'second\n' }, evidence: ['write:write', 'edit:edit'] });
    expect(run.changes[external].capture).toMatchObject({ origin: 'external', absolutePath: external });
    expect(Object.keys(run.changes)).toHaveLength(2); expect(ctx.ui.notify).not.toHaveBeenCalled();
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

it('rejects scratch root/parent junctions before workspace discovery', async () => {
  const temp = await temporary();
  try {
    const parent = path.join(temp, '.pi-desktop', 'data', 'scratch'), outside = path.join(temp, 'outside');
    await fs.mkdir(parent, { recursive: true }); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    const root = path.join(parent, 'session-link');
    await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(checkScratchAncestry(root)).rejects.toThrow('Unsafe scratch');
    expect(await snapshotWorkspace(root, [])).toMatchObject({ complete: false, paths: [] });
    const child = path.join(root, 'child'); await fs.mkdir(child);
    await expect(checkScratchAncestry(child)).rejects.toThrow('Unsafe scratch');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

it('main imports and reopens rootless public evidence without workspace/disk/Git authorization', async () => {
  const temp = await temporary(), sid = randomUUID(), other = randomUUID();
  const host = path.join(temp, '.pi-desktop', 'data'), data = path.join(host, 'plugins', 'data', 'diff-view'), root = path.join(host, 'scratch', sid), entry = path.join(temp, 'main.cjs');
  const file = path.join(root, 'notes.txt'), external = path.join(temp, 'external.txt'), unknown = path.join(temp, 'unknown.txt');
  const oldPi = (globalThis as any).pi, home = vi.spyOn(os, 'homedir').mockReturnValue(temp);
  let plugin: any, loaded = false;
  try {
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(file, 'current disk is not history'); await fs.writeFile(external, 'unrelated disk bytes');
    const review = { version: 1, sessionId: sid, messageId: 'edit', path: external, beforeExists: true, beforeHash: digest('old\n'), afterExists: true, afterHash: digest('new\n') };
    const createdAt = Date.now() - 10000;
    const call = (id: string, name: string, target: string, args: any = {}, details?: any, status = 'success') => ({ id, role: 'tool', createdAt: createdAt + 1, toolCallId: id, toolName: name, toolStatus: status, toolArgs: { path: target, ...args }, toolResult: { isError: status === 'error', details } });
    const messages: any[] = [
      { id: 'user-one', role: 'user', createdAt, content: 'private prompt' },
      call('write', 'Write', file, { content: 'historical\n' }, { review: { version: 1, sessionId: sid, messageId: 'write', path: file, status: 'added', afterHash: digest('historical\n') } }),
      call('edit', 'Edit', external, { old_string: 'old', new_string: 'new' }, { review }),
      call('unknown', 'Write', unknown, { content: 'only tool evidence\n' }),
      call('relative', 'Write', 'relative.txt', { content: 'trusted scratch relative\n' }),
      call('failed', 'Write', path.join(temp, 'failed.txt'), { content: 'not written' }, undefined, 'error'),
      call('pending', 'Edit', path.join(temp, 'pending.txt'), {}, undefined, 'running'),
      call('bash', 'Bash', path.join(temp, 'shell.txt'), { command: 'echo fabricated' }),
      call('private', 'Write', path.join(root, '.env'), { content: 'credential secret' }),
      { id: 'reply-one', role: 'assistant', createdAt: createdAt + 2, status: 'complete', content: 'private reply' },
    ];
    // This same-session plugin capture, not a private scratch path guess, supplies the root and endpoint.
    const store = new SnapshotStore(data);
    await seedCapture(store, { id: 'external-capture', sessionId: sid, root, userMessageId: 'user-one', startedAt: createdAt, changes: { [external]: capturedChange(root, external, snapshotOfText('old\n'), unavailableText('new\n'), ['edit:edit']) } });
    const desktop = publicDesktopFixture({ [sid]: { messages } });
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    (globalThis as any).pi = { desktop, plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    const read = fs.readFile.bind(fs), diskReads = vi.spyOn(fs, 'readFile').mockImplementation(((value: any, ...args: any[]) => {
      if ([file, external, unknown].some(p => canonical(p) === canonical(String(value)))) throw new Error('Historical import must not read current disk');
      return (read as any)(value, ...args);
    }) as any);
    await expect(plugin.onRendererCall('sessionEvidence', { sessionId: sid, chunk: '[]', index: 0, final: true })).rejects.toThrow(/public source/i);
    const recovered = await plugin.onRendererCall('sessionContext', { sessionId: sid, running: true, taskId: 'forged-user', since: Date.now() });
    expect(recovered).toMatchObject({ imported: 1, events: 4, warnings: [] });
    const boot = await plugin.onRendererCall('bootstrap', { sessionId: sid });
    expect(boot.repositories).toEqual([]); expect(boot.recoveryNotice).toBeUndefined(); expect(boot.runs).toHaveLength(1);
    expect(boot.runs[0]).toMatchObject({ sessionId: sid, root, fileCount: 4 });
    const saved = await new SnapshotStore(data).getRun(boot.runs[0].id);
    expect(saved!.changes['notes.txt'].after.text).toBe('historical\n');
    expect(saved!.changes[external]).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' }, capture: { origin: 'external' } });
    expect(saved!.changes[unknown]).toMatchObject({ before: { kind: 'unavailable', text: null }, after: { text: 'only tool evidence\n' } });
    expect(saved!.changes['relative.txt']).toMatchObject({ before: { kind: 'unavailable' }, after: { text: 'trusted scratch relative\n' } });
    const reviewPage = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: boot.runs[0].id });
    expect(reviewPage.files).toHaveLength(4); expect(reviewPage.files.every((f: any) => f.actions.length === 0)).toBe(true);
    const selected = reviewPage.files.find((f: any) => f.path === 'notes.txt');
    await plugin.onRendererCall('file', { reviewId: reviewPage.id, fileId: selected.id });
    await expect(plugin.onRendererCall('action', { reviewId: reviewPage.id, fileId: selected.id, fingerprint: selected.fingerprint, action: 'revert', confirmed: true })).rejects.toThrow();
    await expect(plugin.onRendererCall('gitManage', { operation: 'status', root })).rejects.toThrow();
    expect((await plugin.onRendererCall('bootstrap', { sessionId: other })).runs).toEqual([]);
    await expect(plugin.onRendererCall('selectTurn', { sessionId: other, runId: boot.runs[0].id })).rejects.toThrow();
    await plugin.onUnload(); loaded = false;
    await fs.rm(root, { recursive: true });
    await plugin.onLoad(); loaded = true;
    await expect(plugin.onRendererCall('sessionContext', { sessionId: sid, root: temp, running: false })).resolves.toMatchObject({ ok: false });
    const restored = await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false });
    expect(restored.warnings).toEqual([]);
    const again = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: boot.runs[0].id });
    expect(again.files.every((f: any) => f.actions.length === 0)).toBe(true);
    expect((await plugin.onRendererCall('replyCards', { sessionId: sid })).cards[0].messageId).toBe('reply-one');
    expect((await new SnapshotStore(data).getRun(boot.runs[0].id))!.changes[external].after.text).toBe('new\n');
    expect(JSON.parse(await fs.readFile(path.join(data, 'capture-contexts.json'), 'utf8')).contexts[0].root).toBe(root);
    diskReads.mockRestore();
    expect(await fs.readFile(external, 'utf8')).toBe('unrelated disk bytes');
  } finally { if (loaded) await plugin.onUnload(); vi.restoreAllMocks(); (globalThis as any).pi = oldPi; home.mockRestore(); await fs.rm(temp, { recursive: true, force: true }); }
});

it('imports rootless public running history and keeps even complete settled scratch captures read-only', async () => {
  const temp = await temporary(), sid = randomUUID();
  const host = path.join(temp, '.pi-desktop', 'data'), data = path.join(host, 'plugins', 'data', 'diff-view'), root = path.join(host, 'scratch', sid), entry = path.join(temp, 'main.cjs');
  const oldPi = (globalThis as any).pi, home = vi.spyOn(os, 'homedir').mockReturnValue(temp);
  let plugin: any, loaded = false;
  try {
    const store = new SnapshotStore(data);
    const started = Date.now() - 1000;
    const messages = [
      { type: 'message', id: 'user-one', role: 'user', createdAt: started, blocks: [] },
      { type: 'message', id: 'call', role: 'tool', createdAt: started + 1, blocks: [{ type: 'tool_call', callId: 'call', name: 'Write', status: 'success', args: { path: path.join(root, 'new.txt'), content: 'recorded\n' }, result: { details: { review: { version: 1, messageId: 'call', path: path.join(root, 'new.txt'), status: 'added', afterHash: digest('recorded\n') } } } }] },
      { type: 'message', id: 'edit-message', role: 'tool', createdAt: started + 2, blocks: [{ type: 'tool_call', callId: 'edit-call', name: 'Edit', status: 'success', args: { path: path.join(root, 'new.txt'), old_string: 'recorded', new_string: 'edited' }, result: { details: { review: { version: 1, messageId: 'edit-message', path: 'new.txt', beforeExists: true, beforeHash: digest('recorded\n'), afterExists: true, afterHash: digest('edited\n') } } } }] },
      { type: 'message', id: 'reply', role: 'assistant', createdAt: started + 3, meta: { status: 'complete' }, blocks: [{ type: 'text' }] },
    ];
    // Exact tool IDs (not the edit-message alias) bind plugin-owned endpoints to public calls.
    await seedCapture(store, { id: 'scratch-capture', sessionId: sid, root, userMessageId: 'user-one', startedAt: started, changes: { 'new.txt': {
      ...capturedChange(root, 'new.txt', absentSnapshot(), snapshotOfText('edited\n'), ['write:call', 'edit:edit-call']),
      segments: [
        { before: absentSnapshot(), after: snapshotOfText('recorded\n'), evidence: 'write:call' },
        { before: snapshotOfText('recorded\n'), after: snapshotOfText('edited\n'), evidence: 'edit:edit-call' },
      ],
    } } });
    const session: PublicSessionFixture = { messages, isRunning: true, currentTurnId: 'native-turn' };
    const desktop = publicDesktopFixture({ [sid]: session });
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    (globalThis as any).pi = { desktop, plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    expect((await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false, taskId: 'forged-user', since: started })).imported).toBe(1);
    const live = await plugin.onRendererCall('runningChanges', { sessionId: sid, taskId: 'user-one', since: started });
    expect(live).toMatchObject({ sessionId: sid, fileCount: 1, additions: 1, unknownFileCount: 0 });
    session.isRunning = false; session.currentTurnId = undefined; await expirePublicCache();
    await plugin.onRendererCall('sessionContext', { sessionId: sid, running: true });
    const review = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(review.run).toMatchObject({ root, state: 'completed', incomplete: false });
    const detail = await plugin.onRendererCall('file', { reviewId: review.id, fileId: review.files[0].id });
    expect(detail.file.actions).toEqual([]);
    expect((await new SnapshotStore(data).getRun(live.runId))!.changes['new.txt'].after.text).toBe('edited\n');
    await expect(plugin.onRendererCall('action', { reviewId: review.id, fileId: detail.file.id, fingerprint: detail.file.fingerprint, action: 'revert', confirmed: true })).rejects.toThrow();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    session.messages = [];
    await plugin.onUnload(); loaded = false; await plugin.onLoad(); loaded = true;
    await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false });
    const reopened = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(reopened.run).toMatchObject({ state: 'completed', incomplete: false });
    expect((await new SnapshotStore(data).getRun(live.runId))!.changes['new.txt'].after.text).toBe('edited\n');
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(temp, { recursive: true, force: true }); }
});

it('never guesses a rootless scratch root or imports another session scratch path as external', async () => {
  const temp = await temporary(), sid = randomUUID(), other = randomUUID();
  const host = path.join(temp, '.pi-desktop', 'data'), data = path.join(host, 'plugins', 'data', 'diff-view'), root = path.join(host, 'scratch', sid), entry = path.join(temp, 'main.cjs');
  const foreign = path.join(host, 'scratch', other, 'other.txt'), started = Date.now() - 1000;
  const oldPi = (globalThis as any).pi, home = vi.spyOn(os, 'homedir').mockReturnValue(temp);
  const session: PublicSessionFixture = { messages: [
    { id: 'user-one', role: 'user', createdAt: started, blocks: [] },
    { id: 'own-call', role: 'tool', createdAt: started + 1, toolCallId: 'own-call', toolName: 'Write', toolStatus: 'success', toolArgs: { path: path.join(root, 'own.txt'), content: 'own\n' } },
    { id: 'cross-session', role: 'tool', createdAt: started + 2, toolCallId: 'cross-session', toolName: 'Write', toolStatus: 'success', toolArgs: { path: foreign, content: 'other session\n' } },
  ] };
  const desktop = publicDesktopFixture({ [sid]: session });
  let plugin: any, loaded = false;
  try {
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    (globalThis as any).pi = { desktop, plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    expect(await plugin.onRendererCall('sessionContext', { sessionId: sid })).toMatchObject({ ok: false });
    expect((await plugin.onRendererCall('bootstrap', { sessionId: sid })).runs).toEqual([]);
    // A public projectPath may identify the exact cwd scratch leaf, but not a sibling session.
    session.projectPath = root; await expirePublicCache();
    const result = await plugin.onRendererCall('sessionContext', { sessionId: sid });
    const [run] = (await plugin.onRendererCall('bootstrap', { sessionId: sid })).runs;
    const saved = await new SnapshotStore(data).getRun(run.id);
    expect.soft(Object.keys(saved!.changes)).not.toContain(foreign);
    expect.soft(run).toMatchObject({ sessionId: sid, root, fileCount: 1 });
    expect(result.events).toBe(1);
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(temp, { recursive: true, force: true }); }
});
