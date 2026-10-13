import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest } from '../../src/core/path-policy';
import { transcriptEvidence, evidenceChunks, evidenceRevision } from '../../src/core/host-transcript';
import { SnapshotStore } from '../../src/core/storage';
it('main imports authorized session evidence, isolates shared roots and resolves live user identity', async () => {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'history-main-'));
  const root = path.join(temp, 'project'), host = path.join(temp, 'host'), data = path.join(host, 'plugins', 'data', 'local.diff-view'), entry = path.join(temp, 'main.cjs');
  await fs.mkdir(root); await fs.mkdir(path.join(host, 'sessions'), { recursive: true });
  const createdAt = new Date(Date.now() - 1000).toISOString();
  for (const sid of ['s1', 's2']) {
    const message = (id: string, role: string, blocks: unknown[]) => ({ type: 'message', id, role, blocks, createdAt, meta: { status: 'complete' } });
    await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), [
      { type: 'session', sessionId: sid }, message(`user-${sid}`, 'user', []),
      message(`call-${sid}`, 'tool', [{ type: 'tool_call', callId: `call-${sid}`, name: sid === 's1' ? 'Edit' : 'Write', args: sid === 's1' ? { path: `${sid}.txt`, ops: 'PUT 2.=2:\n+new' } : { path: `${sid}.txt`, content: 'new\n' }, status: 'success', result: { isError: false, details: sid === 's1' ? { review: { version: 1, messageId: `call-${sid}`, path: `${sid}.txt`, hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ type: 'context', text: 'keep' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }] } } : {} } }]),
      message(`reply-${sid}`, 'assistant', [{ type: 'text', text: 'Finished' }])
    ].map(row => JSON.stringify(row)).join('\n'));
    const evidence = path.join(host, 'review-changes', sid, `call-${sid}`); await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'meta.json'), JSON.stringify({ version: 1, sessionId: sid, messageId: `call-${sid}`, path: `${sid}.txt`, operation: sid === 's1' ? 'edit' : 'write', beforeExists: sid === 's1', ...(sid === 's1' ? { beforeHash: digest('keep\r\nold\r\n') } : {}), afterExists: true, afterHash: digest(sid === 's1' ? 'keep\r\nnew\r\n' : 'new\n'), state: 'active' }));
    if (sid === 's1') await fs.writeFile(path.join(evidence, 'before'), 'keep\r\nold\r\n');
  }
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const home = vi.spyOn(os, 'homedir').mockReturnValue(temp), previous = (globalThis as any).pi;
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => ({ path: root }) }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); let loaded = false;
  try {
    await plugin.onLoad(); loaded = true;
    expect((await plugin.onRendererCall('sessionContext', { sessionId: 's1', root, running: true })).imported).toBe(1);
    const running = await plugin.onRendererCall('runningChanges', { sessionId: 's1', since: 0, taskId: 'user-s1' });
    expect(running).toMatchObject({ sessionId: 's1', fileCount: 1, additions: 1, deletions: 1, unknownFileCount: 0 });
    expect(await plugin.onRendererCall('runningChanges', { sessionId: 's1', since: 0, taskId: 'user-s2' })).toBeNull();
    await plugin.onRendererCall('sessionContext', { sessionId: 's2', root, running: false });
    const boot = await plugin.onRendererCall('bootstrap', { sessionId: 's1' });
    expect(boot.runs.every((r: any) => r.sessionId === 's1')).toBe(true);
    const review = await plugin.onRendererCall('review', { scope: 'turn', sessionId: 's1', runId: running.runId });
    expect(review.run).toEqual(boot.runs.find((r: any) => r.id === review.runId));
    expect(review.files[0]).toMatchObject({ path: 's1.txt', additions: 1, deletions: 1, statsKnown: true });
    const detail = await plugin.onRendererCall('file', { reviewId: review.id, fileId: review.files[0].id });
    expect(detail.hunks.flatMap((h: any) => h.lines).some((line: any) => line.kind === 'add' && line.text.replace(/\r$/, '') === 'new')).toBe(true);
    expect((await plugin.onRendererCall('review', { scope: 'turn', sessionId: 's2', runId: running.runId })).run).toBeUndefined();
    expect((await plugin.onRendererCall('bootstrap', {})).runs).toEqual([]);
    await plugin.onRendererCall('sessionContext', { sessionId: 's1', root, running: false });
    expect((await plugin.onRendererCall('replyCards', { sessionId: 's1' })).cards.map((c: any) => c.messageId)).toEqual(['reply-s1']);
    expect((await plugin.onRendererCall('replyCards', { sessionId: 's2' })).cards.map((c: any) => c.messageId)).toEqual(['reply-s2']);
    // A newly imported capture must recover before publishing, even inside the 2s throttle.
    const snapshots = new SnapshotStore(data), native = (await snapshots.getRun(running.runId))!;
    const original = native.changes['s1.txt'];
    const damaged = { ...native, id: 'new-agent-capture', source: undefined, generation: 'agent', contentVersion: 4, hostRecovery: undefined, changes: { 's1.txt': { ...original, evidence: ['edit:call-s1'], ambiguous: true, before: { ...original.before, kind: 'unavailable' as const, text: null }, after: { ...original.after, kind: 'unavailable' as const, text: null } } } };
    await snapshots.writeRun(damaged, true);
    await fs.rm(path.join(data, 'runs', `${native.id}.json`));
    const immediate = await plugin.onRendererCall('review', { scope: 'lastTurn', sessionId: 's1', root });
    expect(immediate.runId).toBe(damaged.id);
    expect(immediate.files[0]).toMatchObject({ kind: 'text', statsKnown: true, additions: 1, deletions: 1 });
    expect((await plugin.onRendererCall('file', { reviewId: immediate.id, fileId: immediate.files[0].id })).hunks.length).toBeGreaterThan(0);
    const since = Date.now();
    await fs.appendFile(path.join(host, 'sessions', 's1.jsonl'), '\n' + JSON.stringify({ type: 'message', id: 'new-user-s1', role: 'user', blocks: [], createdAt: new Date(since).toISOString(), meta: { status: 'complete' } }));
    await plugin.onRendererCall('sessionContext', { sessionId: 's1', root, running: true, taskId: 'new-user-s1', since });
    const current = await plugin.onRendererCall('review', { scope: 'lastTurn', sessionId: 's1', root });
    expect(current.run).toMatchObject({ state: 'completed', fileCount: 1 });
    expect(current.runId).toBe(damaged.id); expect(current.files).toHaveLength(1);
    expect((await plugin.onRendererCall('bootstrap', { sessionId: 's1' })).runs.filter((run: any) => run.state === 'running')).toHaveLength(1);
    expect(await plugin.onRendererCall('runningChanges', { sessionId: 's1', since, taskId: 'new-user-s1' })).toBeNull();
    expect(await plugin.onRendererCall('sessionContext', { sessionId: 's1', root: temp, running: false })).toMatchObject({ ok: false, warning: expect.stringContaining('未授权') });
    expect(await plugin.onRendererCall('bootstrap', { sessionId: 's1' })).not.toHaveProperty('recoveryNotice');
    await expect(plugin.onRendererCall('gitManage', { operation: 'status', root: temp })).rejects.toThrow();
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); }
});
it('main restores live native evidence before JSONL flush and settles the open review', async () => {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'history-live-main-'));
  const root = path.join(temp, 'project'), host = path.join(temp, 'host'), data = path.join(host, 'plugins', 'data', 'local.diff-view'), entry = path.join(temp, 'main.cjs');
  const sid = 'live-session', callId = 'call_one|fc_one', createdAt = new Date(Date.now() - 10000).toISOString();
  await fs.mkdir(root); await fs.mkdir(path.join(host, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), JSON.stringify({ type: 'message', id: 'user-one', role: 'user', createdAt, blocks: [], meta: { status: 'complete' } }) + '\n');
  const dir = path.join(host, 'review-changes', sid, 'snapshot-one'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'before'), 'old\n');
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId: sid, messageId: callId, path: 'a.txt', operation: 'edit', beforeExists: true, beforeHash: digest('old\n'), afterExists: true, afterHash: digest('new\n') }));
  const messages = [
    { id: 'user-one', role: 'user', createdAt, content: 'private prompt' },
    { id: callId, role: 'tool', createdAt: new Date(Date.now() - 9000).toISOString(), toolCallId: callId, toolName: 'Edit', toolArgs: { path: 'a.txt' }, toolStatus: 'success', status: 'complete', toolResult: { details: { review: { version: 1, messageId: callId, path: 'a.txt', hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }] } } } }
  ];
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const home = vi.spyOn(os, 'homedir').mockReturnValue(temp), previous = (globalThis as any).pi, handlers: Record<string, Function> = {};
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => ({ path: root }) }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on(name: string, fn: Function) { handlers[name] = fn; }, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); let loaded = false;
  const publish = async (running: boolean) => {
    const text = transcriptEvidence(messages), revision = evidenceRevision(text), chunks = evidenceChunks(text);
    for (const [index, chunk] of chunks.entries()) await plugin.onRendererCall('sessionEvidence', { sessionId: sid, root, revision, index, chunk, final: index === chunks.length - 1 });
    return plugin.onRendererCall('sessionContext', { sessionId: sid, root, running, taskId: 'user-one', evidenceRevision: revision });
  };
  try {
    await plugin.onLoad(); loaded = true; await publish(true);
    const live = await plugin.onRendererCall('runningChanges', { sessionId: sid, since: 0, taskId: 'user-one' });
    expect(live).toMatchObject({ additions: 1, deletions: 1, unknownFileCount: 0 });
    messages.push({ id: 'reply-one', role: 'assistant', createdAt: new Date(Date.now() - 1000).toISOString(), content: 'private reply', status: 'complete' } as any);
    await publish(false); handlers['session:turnEnded']({ sessionId: sid, turnId: 'internal-turn', reason: 'completed' });
    const review = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(review.run).toMatchObject({ state: 'completed', incomplete: false }); expect(review.files[0]).toMatchObject({ additions: 1, deletions: 1, statsKnown: true });
    expect((await plugin.onRendererCall('replyCards', { sessionId: sid })).cards[0].messageId).toBe('reply-one');
    expect(await plugin.onRendererCall('runningChanges', { sessionId: sid, since: 0, taskId: 'user-one' })).toBeNull();
    await plugin.onUnload(); loaded = false;
    await fs.rm(path.join(host, 'sessions', `${sid}.jsonl`));
    await fs.rm(path.join(dir, 'before'));
    await plugin.onLoad(); loaded = true;
    const empty = transcriptEvidence([]), emptyRevision = evidenceRevision(empty);
    await plugin.onRendererCall('sessionEvidence', { sessionId: sid, root, revision: emptyRevision, index: 0, chunk: empty, final: true });
    const recovery = await plugin.onRendererCall('sessionContext', { sessionId: sid, root, running: false, evidenceRevision: emptyRevision });
    expect(recovery.warnings).toEqual([]);
    expect(recovery.unchanged).toBe(1);
    const restored = await plugin.onRendererCall('review', { scope: 'turn', sessionId: sid, runId: live.runId });
    expect(restored.run).toMatchObject({ state: 'completed', incomplete: false });
    expect(restored.files[0]).toMatchObject({ additions: 1, deletions: 1, statsKnown: true });
    expect((await plugin.onRendererCall('replyCards', { sessionId: sid })).cards[0].messageId).toBe('reply-one');
    const archiveFiles = await fs.readdir(path.join(data, 'evidence'));
    expect(archiveFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(data, 'evidence', archiveFiles[0]), 'utf8')).not.toMatch(/private prompt|private reply/);
    await plugin.onRendererCall('clearHistory', { confirmed: true });
    expect(await fs.readdir(path.join(data, 'evidence'))).toEqual([]);
    await plugin.onRendererCall('sessionContext', { sessionId: sid, root, running: false });
    expect((await plugin.onRendererCall('bootstrap', { sessionId: sid })).runs).toEqual([]);
    await expect(plugin.onRendererCall('sessionEvidence', { sessionId: sid, root: temp, revision: '2-0', index: 0, chunk: '[]', final: true })).rejects.toThrow(/Unauthorized/);
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); }
});
