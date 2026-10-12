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
import { canonical, digest } from '../../src/core/path-policy';
import { transcriptEvidence, evidenceChunks, evidenceRevision } from '../../src/core/host-transcript';

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

it('main imports and reopens no-project evidence without workspace/disk/Git authorization, before host transcript flush', async () => {
  const temp = await temporary(), sid = randomUUID(), other = randomUUID();
  const host = path.join(temp, '.pi-desktop', 'data'), data = path.join(host, 'plugins', 'data', 'diff-view'), root = path.join(host, 'scratch', sid), entry = path.join(temp, 'main.cjs');
  const file = path.join(root, 'notes.txt'), external = path.join(temp, 'external.txt'), unknown = path.join(temp, 'unknown.txt');
  const oldPi = (globalThis as any).pi, home = vi.spyOn(os, 'homedir').mockReturnValue(temp);
  let plugin: any, loaded = false;
  try {
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(file, 'current disk is not history'); await fs.writeFile(external, 'unrelated disk bytes');
    const beforeDir = path.join(host, 'review-changes', sid, 'external-call'); await fs.mkdir(beforeDir, { recursive: true });
    await fs.writeFile(path.join(beforeDir, 'before'), 'old\n');
    const review = { version: 1, sessionId: sid, messageId: 'edit', path: external, beforeExists: true, beforeHash: digest('old\n'), afterExists: true, afterHash: digest('new\n') };
    await fs.writeFile(path.join(beforeDir, 'meta.json'), JSON.stringify(review));
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
      call('cross-session', 'Write', path.join(host, 'scratch', other, 'other.txt'), { content: 'other session' }),
      { id: 'reply-one', role: 'assistant', createdAt: createdAt + 2, status: 'complete', content: 'private reply' },
    ];
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    const read = fs.readFile.bind(fs), diskReads = vi.spyOn(fs, 'readFile').mockImplementation(((value: any, ...args: any[]) => {
      if ([file, external, unknown].some(p => canonical(p) === canonical(String(value)))) throw new Error('Historical import must not read current disk');
      return (read as any)(value, ...args);
    }) as any);
    const text = transcriptEvidence(messages), revision = evidenceRevision(text), chunks = evidenceChunks(text);
    for (const [index, chunk] of chunks.entries()) await plugin.onRendererCall('sessionEvidence', { sessionId: sid, revision, index, chunk, final: index === chunks.length - 1 });
    const recovered = await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false, evidenceRevision: revision });
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
    await fs.rm(beforeDir, { recursive: true }); await fs.rm(root, { recursive: true });
    await plugin.onLoad(); loaded = true;
    const restored = await plugin.onRendererCall('sessionContext', { sessionId: sid, root: temp, running: false });
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

it('imports rootless native JSONL running history and keeps even complete settled scratch captures read-only', async () => {
  const temp = await temporary(), sid = randomUUID();
  const host = path.join(temp, '.pi-desktop', 'data'), data = path.join(host, 'plugins', 'data', 'diff-view'), root = path.join(host, 'scratch', sid), entry = path.join(temp, 'main.cjs');
  const oldPi = (globalThis as any).pi, home = vi.spyOn(os, 'homedir').mockReturnValue(temp);
  let plugin: any, loaded = false;
  try {
    await fs.mkdir(path.join(host, 'sessions'), { recursive: true });
    const started = Date.now() - 1000;
    const messages = [
      { type: 'session', sessionId: sid },
      { type: 'message', id: 'user-one', role: 'user', createdAt: started, blocks: [] },
      { type: 'message', id: 'call', role: 'tool', createdAt: started + 1, blocks: [{ type: 'tool_call', callId: 'call', name: 'Write', status: 'success', args: { path: path.join(root, 'new.txt'), content: 'recorded\n' }, result: { details: { review: { version: 1, messageId: 'call', path: path.join(root, 'new.txt'), status: 'added', afterHash: digest('recorded\n') } } } }] },
      { type: 'message', id: 'edit-message', role: 'tool', createdAt: started + 2, blocks: [{ type: 'tool_call', callId: 'edit-call', name: 'Edit', status: 'success', args: { path: path.join(root, 'new.txt'), old_string: 'recorded', new_string: 'edited' }, result: {} }] },
      { type: 'message', id: 'reply', role: 'assistant', createdAt: started + 3, meta: { status: 'complete' }, blocks: [{ type: 'text' }] },
    ];
    await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), messages.map(v => JSON.stringify(v)).join('\n'));
    // Metadata uses a message alias and relative path; fallback must not overwrite its snapshots.
    const evidence = path.join(host, 'review-changes', sid, 'edit-call'); await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'meta.json'), JSON.stringify({ version: 1, sessionId: sid, messageId: 'edit-message', path: 'new.txt', beforeExists: true, beforeHash: digest('recorded\n'), afterExists: true, afterHash: digest('edited\n') }));
    await fs.writeFile(path.join(evidence, 'before'), 'recorded\n'); await fs.writeFile(path.join(evidence, 'after'), 'edited\n');
    await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
    (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
    plugin = createRequire(import.meta.url)(entry); await plugin.onLoad(); loaded = true;
    expect((await plugin.onRendererCall('sessionContext', { sessionId: sid, running: true, taskId: 'user-one', since: started })).imported).toBe(1);
    const live = await plugin.onRendererCall('runningChanges', { sessionId: sid, taskId: 'user-one', since: started });
    expect(live).toMatchObject({ sessionId: sid, fileCount: 1, additions: 1, unknownFileCount: 0 });
    await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false });
    const review = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(review.run).toMatchObject({ root, state: 'completed', incomplete: false });
    const detail = await plugin.onRendererCall('file', { reviewId: review.id, fileId: review.files[0].id });
    expect(detail.file.actions).toEqual([]);
    expect((await new SnapshotStore(data).getRun(live.runId))!.changes['new.txt'].after.text).toBe('edited\n');
    await expect(plugin.onRendererCall('action', { reviewId: review.id, fileId: detail.file.id, fingerprint: detail.file.fingerprint, action: 'revert', confirmed: true })).rejects.toThrow();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(evidence, { recursive: true });
    await plugin.onUnload(); loaded = false; await plugin.onLoad(); loaded = true;
    await plugin.onRendererCall('sessionContext', { sessionId: sid, running: false });
    const reopened = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(reopened.run).toMatchObject({ state: 'completed', incomplete: false });
    expect((await new SnapshotStore(data).getRun(live.runId))!.changes['new.txt'].after.text).toBe('edited\n');
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(temp, { recursive: true, force: true }); }
});
