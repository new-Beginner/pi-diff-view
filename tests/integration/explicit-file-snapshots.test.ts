import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCaptureExtension } from '../../src/agent/capture';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { absentSnapshot, canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import { HostHistoryImporter, hostHistoryRunId } from '../helpers/history-fixture';
import { ReviewService } from '../../src/core/review-service';
import type { CaptureRun } from '../../src/core/contracts';
import { inspectCaptureLeases } from '../../src/agent/workspace-capture';

let temp: string, host: string, root: string, plugin: string, locator: string, generation: string, sid: string, store: SnapshotStore;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'explicit-snapshots-'));
  sid = randomUUID(); generation = randomUUID(); host = path.join(temp, '.pi-desktop', 'data');
  root = path.join(host, 'scratch', sid); plugin = path.join(temp, 'plugin'); locator = path.join(temp, 'locator.json');
  store = new SnapshotStore(path.join(host, 'plugins', 'data', 'diff-view'));
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(plugin); await store.init();
  await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });
function harness() {
  const hooks: Record<string, Function> = {}, ctx = { cwd: root, sessionManager: { getSessionId: () => sid }, ui: { notify: vi.fn() } };
  createCaptureExtension({ pluginRoot: plugin, locator })({ on: (event, callback) => { hooks[event] = callback; } });
  return { emit: (event: string, args: any = {}) => hooks[event]?.(args, ctx), ctx };
}
async function saved() { await store.importInbox(generation); return (await store.listRuns())[0]; }
const identity = () => { const absolutePath = path.join(root, 'a.txt'), value = canonical(absolutePath); return { id: digest(value).slice(0, 24), identity: value, path: 'a.txt', origin: 'workspace' as const, absolutePath }; };
function source(id: string, after: ReturnType<typeof snapshotOfText>): CaptureRun {
  return { version: 2, id, generation, sessionId: sid, root, startedAt: 1, state: 'completed', fileCount: 1, incomplete: false, boundary: 'user', userMessageId: 'user', replies: [], bindings: {}, changes: { 'a.txt': { capture: identity(), before: snapshotOfText('old\n'), after, evidence: ['edit:edit'] } } };
}
async function transcript(name = 'Edit') {
  await fs.mkdir(path.join(host, 'sessions'), { recursive: true });
  const rows = [
    { type: 'session', sessionId: sid, schema: 1 },
    { type: 'message', id: 'user', role: 'user', createdAt: 1, blocks: [], meta: { status: 'complete' } },
    { type: 'message', id: 'edit', role: 'tool', createdAt: 2, blocks: [{ type: 'tool_call', callId: 'edit', name, args: { path: path.join(root, 'a.txt') }, status: 'success', result: { isError: false } }], meta: { status: 'complete' } },
    { type: 'message', id: 'reply', role: 'assistant', createdAt: 3, blocks: [{ type: 'text', text: 'done' }], meta: { status: 'complete' } },
  ];
  await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n'));
}

it('keeps per-call snapshots across a gap, displays read-only segments, and never scans the workspace', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'old\n');
  const scan = vi.spyOn(fs, 'readdir'); await h.emit('before_agent_start', { userMessageId: 'user' });
  for (const [id, before, after] of [['one', 'old\n', 'first\n'], ['two', 'restored\n', 'final\n']] as const) {
    await fs.writeFile(file, before); await h.emit('tool_call', { toolName: 'Edit', toolCallId: id, input: { path: file } });
    await fs.writeFile(file, after); await h.emit('tool_result', { toolCallId: id });
  }
  await h.emit('agent_end'); const run = await saved(), change = run.changes['a.txt'] as any;
  expect(change.ambiguous).toBe(true);
  expect(change.segments).toHaveLength(2);
  expect(change.segments.map((s: any) => [s.before.text, s.after.text])).toEqual([['old\n', 'first\n'], ['restored\n', 'final\n']]);
  expect(change.segments.every((s: any) => !s.ambiguous)).toBe(true);
  expect(scan.mock.calls.some(([p]) => canonical(String(p)) === canonical(root))).toBe(false);
  // A later user edit must not become historical content.
  await fs.writeFile(file, 'current disk is unrelated\n');
  const read = fs.readFile.bind(fs); vi.spyOn(fs, 'readFile').mockImplementation(((p: any, ...args: any[]) => {
    if (canonical(String(p)) === canonical(file)) throw new Error('Do not read current file');
    return (read as any)(p, ...args);
  }) as any);
  const service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, generation);
  const review = await service.review({ scope: 'turn', sessionId: sid, runId: run.id }), selected = review.files[0] as any;
  expect(selected).toMatchObject({ segmentCount: 2, statsKnown: false, actions: [] });
  const detail = await service.file({ reviewId: review.id, fileId: selected.id });
  expect(detail.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add').map(l => l.text)).toEqual(['first', 'final']);
  expect(detail.hunks.some(h => h.header.includes('分段'))).toBe(true);
  const summary = await service.turnSummary({ runId: run.id, sessionId: sid });
  expect(summary).toMatchObject({ additions: 0, deletions: 0, unknownFileCount: 1 });
});

it('captures FastCtx single-file replacement and skips dry runs, directories and unrelated plugin paths', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  const scan = vi.spyOn(fs, 'readdir'); await h.emit('before_agent_start', { userMessageId: 'user' });
  for (const [id, toolName, input] of [
    ['preview', 'mcp_fastctx_replace', { path: file, dry_run: true }],
    ['directory', 'mcp_fastctx_replace', { path: root }],
    ['plugin', 'plugin_unknown_writer', { path: file }],
  ] as const) { await h.emit('tool_call', { toolName, toolCallId: id, input }); await h.emit('tool_result', { toolCallId: id }); }
  await h.emit('tool_call', { toolName: 'functions.mcp_fastctx_replace', toolCallId: 'replace', input: { path: file } });
  await fs.writeFile(file, 'after\n'); await h.emit('tool_result', { toolCallId: 'replace' }); await h.emit('agent_end');
  const run = await saved(); expect(Object.keys(run.changes)).toEqual(['a.txt']);
  expect(run.changes['a.txt']).toMatchObject({ before: { text: 'before\n' }, after: { text: 'after\n' }, evidence: ['mcp_fastctx_replace:replace'] });
  expect(run.incomplete).toBe(false); expect(scan.mock.calls.some(([p]) => canonical(String(p)) === canonical(root))).toBe(false);
});

it('does not present overlapping tool intervals as trustworthy segments', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'old\n'); await h.emit('before_agent_start');
  await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'one', input: { path: file } });
  await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'two', input: { path: file } });
  await fs.writeFile(file, 'new\n'); await h.emit('tool_result', { toolCallId: 'one' }); await h.emit('tool_result', { toolCallId: 'two' }); await h.emit('agent_end');
  const change = (await saved()).changes['a.txt'] as any;
  expect(change.segments).toHaveLength(2); expect(change.segments.every((s: any) => s.ambiguous)).toBe(true);
});

it.each([false, true])('ignores unverifiable placeholders but keeps real content conflicts (conflict: %s)', async conflict => {
  await transcript();
  const unknown = { ...snapshotOfText('not saved\n'), hash: 'unknown', kind: 'unavailable' as const, text: null };
  await store.writeRun(source('old-source', conflict ? snapshotOfText('different\n') : unknown));
  await store.writeRun(source('valid-source', snapshotOfText('new\n')));
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  const run = (await store.getRun(hostHistoryRunId(sid, 'user')))!;
  expect(run.changes['a.txt'].after.kind).toBe(conflict ? 'unavailable' : 'text');
  if (!conflict) expect(run.changes['a.txt'].after.text).toBe('new\n');
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.getRun(hostHistoryRunId(sid, 'user')))!.changes['a.txt'].after.kind).toBe(conflict ? 'unavailable' : 'text');
});

it('imports exact replacement segment evidence without reading the current file or inventing directory events', async () => {
  await transcript('mcp_fastctx_replace');
  const change = source('capture-source', snapshotOfText('new\n'));
  change.changes['a.txt'].evidence = ['mcp_fastctx_replace:edit'];
  (change.changes['a.txt'] as any).segments = [{ evidence: 'mcp_fastctx_replace:edit', before: snapshotOfText('old\n'), after: snapshotOfText('new\n') }];
  await store.writeRun(change);
  const read = vi.spyOn(fs, 'readFile');
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  const run = (await store.getRun(hostHistoryRunId(sid, 'user')))!;
  expect(run.changes['a.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' } });
  expect(read.mock.calls.some(([p]) => canonical(String(p)) === canonical(path.join(root, 'a.txt')))).toBe(false);
});

it.each([false, true])('preserves verified absence and ignores corrupt competing blobs (deleted: %s)', async deleted => {
  await transcript();
  await store.writeRun(source('corrupt-source', snapshotOfText('corrupt\n')));
  await fs.writeFile(path.join(store.directory, 'blobs', digest('corrupt\n')), 'wrong bytes');
  await store.writeRun(source('valid-source', deleted ? absentSnapshot() : snapshotOfText('new\n')));
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  const change = (await store.getRun(hostHistoryRunId(sid, 'user')))!.changes['a.txt'];
  expect(change.after.kind).toBe('text'); expect(change.after.exists).toBe(!deleted);
  expect(change.after.text).toBe(deleted ? null : 'new\n');
});

it('bounds segment metadata and does not rewrite or rehash retained segment text', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, '0\n'); await h.emit('before_agent_start');
  for (let i = 1; i <= 34; i++) {
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: `edit-${i}`, input: { path: file } });
    await fs.writeFile(file, `${i}\n`); await h.emit('tool_result', { toolCallId: `edit-${i}` });
  }
  await h.emit('agent_end'); const run = await saved(), change = run.changes['a.txt'];
  expect(change.segments).toHaveLength(32); expect(change.segmentsTruncated).toBe(true); expect(run.incomplete).toBe(true);
  const metadata = (await store.getRun(run.id, false, false))!.changes['a.txt'];
  expect(metadata.segments!.every(s => s.before.text === null && s.after.text === null)).toBe(true);
  expect((await fs.readdir(path.join(store.directory, 'blobs'))).length).toBe(35);
});

it.each([false, true])('persists the exact before endpoint before mutation (absent: %s)', async absent => {
  const h = harness(), file = path.join(root, 'a.txt');
  if (!absent) await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  const leases = await inspectCaptureLeases(new SnapshotStore(store.directory));
  const prepared = (leases.leases[0] as any).prepared;
  expect(prepared).toMatchObject({ name: 'write', userMessageId: 'user', paths: [{ before: { exists: !absent, text: null, kind: 'text' } }] });
  if (!absent) expect(await fs.readFile(path.join(store.directory, 'blobs', prepared.paths[0].before.hash), 'utf8')).toBe('before\n');
  await store.importInbox(generation);
  expect(await store.listRuns()).toHaveLength(0); // Preparation is not a completed change.
});

async function writeHistory(status = 'success', content = 'after\n') {
  await transcript('Write');
  const file = path.join(host, 'sessions', `${sid}.jsonl`);
  const rows = (await fs.readFile(file, 'utf8')).split('\n').map(line => JSON.parse(line));
  Object.assign(rows[2].blocks[0], { args: { path: path.join(root, 'a.txt'), content }, status, result: { isError: status === 'error' } });
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
}

it.each([false, true])('recovers exact durable before after closure loss, idempotently and without live reads (absent: %s)', async absent => {
  const h = harness(), file = path.join(root, 'a.txt');
  if (!absent) await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await fs.writeFile(file, 'unrelated current bytes\n'); // The old closure never receives a result.
  await writeHistory();
  await store.importInbox(generation);
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((p: any, ...args: any[]) => {
    if (canonical(String(p)) === canonical(file)) throw new Error('No historical live reads');
    return (read as any)(p, ...args);
  }) as any);
  for (let i = 0; i < 2; i++) {
    const restarted = new SnapshotStore(store.directory);
    await new HostHistoryImporter(restarted, host).syncSession(sid, root);
    const runs = await restarted.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].changes['a.txt']).toMatchObject({ before: { exists: !absent, text: absent ? null : 'before\n', kind: 'text' }, after: { text: 'after\n', kind: 'text' } });
    expect(runs[0].changes['a.txt'].segments).toHaveLength(1);
  }
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(0);
});

it.each(['pending', 'error'])('does not turn a %s preparation into a change or retire its lease', async status => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await writeHistory(status); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect(await store.listRuns()).toHaveLength(0);
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(1);
});

it('records bounded sanitized per-path failures instead of silently losing before', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  const read = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(((p: any, ...args: any[]) => {
    if (canonical(String(p)) === canonical(file)) throw Object.assign(new Error('secret-content-and-path'), { code: 'EACCES' });
    return (read as any)(p, ...args);
  }) as any);
  await h.emit('before_agent_start', { userMessageId: 'user' });
  for (let i = 0; i < 20; i++) {
    await h.emit('tool_call', { toolName: 'Write', toolCallId: `failed-${i}`, input: { path: file, content: 'after\n' } });
    await h.emit('tool_result', { toolCallId: `failed-${i}` });
  }
  const audit = await fs.readFile(path.join(store.directory, 'actions.jsonl'), 'utf8');
  expect(audit).toContain('EACCES'); expect(audit).toContain('capture-before');
  expect(audit).not.toContain('secret-content-and-path'); expect(audit).not.toContain(file);
  expect(audit.trim().split('\n').length).toBeLessThanOrEqual(16);
  expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
});

it('keeps overlapping preparations conservative after restart', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  for (const id of ['edit', 'other']) await h.emit('tool_call', { toolName: 'Write', toolCallId: id, input: { path: file, content: 'after\n' } });
  await writeHistory(); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt'].before.kind).toBe('unavailable');
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(2);
});

it('degrades visibly when preparation persistence fails, without blocking the mutation', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  const save = vi.spyOn(SnapshotStore.prototype, 'saveBlob').mockRejectedValueOnce(Object.assign(new Error('secret failure'), { code: 'ENOSPC' }));
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  expect((await inspectCaptureLeases(store)).leases[0].prepared).toBeUndefined();
  expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
  save.mockRestore(); await fs.writeFile(file, 'after\n'); await h.emit('tool_result', { toolCallId: 'edit' });
  const run = await saved(); expect(run.incomplete).toBe(true);
  expect(run.changes['a.txt'].before.text).toBe('before\n');
  expect(await fs.readFile(path.join(store.directory, 'actions.jsonl'), 'utf8')).toContain('ENOSPC');
});

it('keeps preparation through result persistence failure and retries duplicate results without duplicate segments', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await fs.writeFile(file, 'after\n');
  const write = vi.spyOn(SnapshotStore.prototype, 'writeRun').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await h.emit('tool_result', { toolCallId: 'edit' });
  expect((await inspectCaptureLeases(store)).leases[0]).toMatchObject({ closed: true, prepared: { name: 'write' } });
  write.mockRestore();
  await fs.writeFile(file, 'unrelated late bytes\n');
  await h.emit('tool_result', { toolCallId: 'edit' }); await h.emit('tool_result', { toolCallId: 'edit' });
  const change = (await saved()).changes['a.txt'];
  expect(change.segments).toHaveLength(1); expect(change.after.text).toBe('after\n');
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(0);
});

it('recovers a prepared operation after empty runner settlement and a late terminal result', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await h.emit('agent_end'); await fs.writeFile(file, 'after\n');
  await h.emit('tool_result', { toolCallId: 'edit' });
  await writeHistory(); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt']).toMatchObject({ before: { text: 'before\n' }, after: { text: 'after\n' } });
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(0);
});

it('retains before when the terminal after read fails, then recovers from historical evidence', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await fs.writeFile(file, 'after\n');
  const open = fs.open.bind(fs), spy = vi.spyOn(fs, 'open').mockImplementation(((p: any, ...args: any[]) => {
    if (canonical(String(p)) === canonical(file)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return (open as any)(p, ...args);
  }) as any);
  await h.emit('tool_result', { toolCallId: 'edit' }); spy.mockRestore();
  expect((await inspectCaptureLeases(store)).leases[0].prepared).toBeDefined();
  await writeHistory(); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt'].before.text).toBe('before\n');
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(0);
});

it.each(['sessionId', 'executionId', 'userMessageId', 'path', 'corrupt'])('rejects mismatched preparation provenance: %s', async mismatch => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  const journal = path.join(store.directory, 'capture-leases.json'), data = JSON.parse(await fs.readFile(journal, 'utf8')), lease = data.leases[0];
  if (mismatch === 'userMessageId') lease.prepared.userMessageId = 'different-user';
  else if (mismatch === 'path') lease.prepared.paths[0].capture.identity = 'different-path';
  else if (mismatch === 'corrupt') await fs.writeFile(path.join(store.directory, 'blobs', lease.prepared.paths[0].before.hash), 'corrupt bytes');
  else lease[mismatch] = randomUUID();
  await atomicJson(journal, data); await writeHistory(); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt'].before.kind).toBe('unavailable');
  expect(JSON.parse(await fs.readFile(journal, 'utf8')).leases).toHaveLength(1);
});

it('rechecks preparation ambiguity under lock before publishing recovery', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await writeHistory(); await store.importInbox(generation);
  const hydrate = store.hydrate.bind(store); let injected = false;
  vi.spyOn(store, 'hydrate').mockImplementation(async snapshot => {
    if (!injected) { injected = true; await h.emit('tool_call', { toolName: 'Write', toolCallId: 'concurrent', input: { path: file, content: 'other\n' } }); }
    return hydrate(snapshot);
  });
  const d = await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect(d.warnings).toContain('Capture preparation changed; retry recovery');
  expect(await store.listRuns()).toHaveLength(0);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt'].before.kind).toBe('unavailable');
});

it('refuses history clear while unresolved preparation still references before blobs', async () => {
  const h = harness(), file = path.join(root, 'a.txt'); await fs.writeFile(file, 'before\n');
  await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Write', toolCallId: 'edit', input: { path: file, content: 'after\n' } });
  await h.emit('agent_end'); await store.importInbox(generation);
  await expect(store.clear()).rejects.toMatchObject({ code: 'AGENT_BUSY' });
  expect(await fs.readFile(path.join(store.directory, 'blobs', digest('before\n')), 'utf8')).toBe('before\n');
  await writeHistory(); await new HostHistoryImporter(store, host).syncSession(sid, root);
  await expect(store.clear()).resolves.toBeUndefined();
  expect(await store.listRuns()).toHaveLength(0);
});

it('recovers an interrupted Edit only from durable before plus the recorded result hash', async () => {
  const h = harness(), file = path.join(root, 'a.txt'), args = { path: file, old_string: 'before', new_string: 'after' };
  await fs.writeFile(file, 'before\n'); await h.emit('before_agent_start', { userMessageId: 'user' });
  await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'edit', input: args });
  await writeHistory();
  const transcriptFile = path.join(host, 'sessions', `${sid}.jsonl`), rows = (await fs.readFile(transcriptFile, 'utf8')).split('\n').map(line => JSON.parse(line));
  Object.assign(rows[2].blocks[0], { name: 'Edit', args, result: { isError: false, details: { review: { version: 1, sessionId: sid, messageId: 'edit', path: file, afterExists: true, afterHash: digest('after\n') } } } });
  await fs.writeFile(transcriptFile, rows.map(row => JSON.stringify(row)).join('\n'));
  await fs.writeFile(file, 'unrelated\n'); await store.importInbox(generation);
  await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect((await store.listRuns())[0].changes['a.txt']).toMatchObject({ before: { text: 'before\n' }, after: { text: 'after\n' } });
  expect((await inspectCaptureLeases(store)).leases).toHaveLength(0);
});
