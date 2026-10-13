import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { HostHistoryImporter, hostHistoryRunId } from '../../src/core/host-history';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let temp: string, host: string, root: string, store: SnapshotStore, importer: HostHistoryImporter, service: ReviewService;
const sid = 'current-session', now = Date.now() - 10000;
const user = (id: string, createdAt: number) => ({ type: 'message', id, role: 'user', createdAt, blocks: [], meta: {} });
const reply = (id: string, createdAt: number) => ({ type: 'message', id, role: 'assistant', createdAt, blocks: [{ type: 'text' }], meta: { status: 'complete' } });
const tool = (id: string, createdAt: number, meta = {}) => ({ type: 'message', id, role: 'tool', createdAt, meta, blocks: [{ type: 'tool_call', callId: id, name: 'Write', args: { path: path.join(root, 'native.txt'), content: 'new\n' }, status: 'success', result: { isError: false } }] });
const context = (taskId = 'new-user') => ({ sessionId: sid, root, running: true, taskId, since: now + 4000, updatedAt: Date.now() });
async function session(rows: object[]) { await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
function captured(id: string, userMessageId: string, startedAt: number, evidence: string[] = ['write:old-write']): CaptureRun {
  const absolutePath = path.join(root, 'agent.txt'), identity = canonical(absolutePath);
  return { version: 2, id, userMessageId, sessionId: sid, root, startedAt, state: 'running', generation: 'generation', boundary: 'user', incomplete: false, contentVersion: 3, fileCount: 1, changes: { 'agent.txt': { capture: { id: digest(identity).slice(0, 24), identity, absolutePath, origin: 'workspace', path: 'agent.txt' }, before: snapshotOfText('old\n'), after: snapshotOfText('new\n'), evidence } }, replies: [], bindings: {} };
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'current-turn-'));
  host = path.join(temp, 'host'); root = path.join(temp, 'project');
  await fs.mkdir(path.join(host, 'sessions'), { recursive: true }); await fs.mkdir(root);
  store = new SnapshotStore(path.join(temp, 'store')); await store.init(); importer = new HostHistoryImporter(store, host);
  service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, 'generation');
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

it('shows the previous modified turn before current JSONL flush without merging its changes into the empty current capture', async () => {
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000)]);
  await importer.syncSession(sid, root);
  const activity = context();
  await importer.syncSession(sid, root, activity);
  expect((await store.getRun(hostHistoryRunId(sid, 'old-user')))!.state).toBe('completed');
  const review = await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, activity);
  expect(review.run).toMatchObject({ id: hostHistoryRunId(sid, 'old-user'), state: 'completed', fileCount: 1 });
  expect(review.files).toHaveLength(1);
  expect((await store.getRun(hostHistoryRunId(sid, 'new-user')))!.changes).toEqual({});
  expect((await service.bootstrap(sid)).runs.filter(run => run.state === 'running')).toHaveLength(1);
  await importer.syncSession(sid, root, { running: false });
  expect((await store.listRuns(false, true)).filter(run => run.state === 'running')).toEqual([]);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, { ...activity, running: false })).runId).toBe(hostHistoryRunId(sid, 'old-user'));
});

it('shows previous recorded changes when the current identity has no capture yet', async () => {
  await store.writeRun(captured('older-capture', 'old-user', now));
  const review = await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, context());
  expect(review.files).toHaveLength(1); expect(review.runId).toBe('older-capture');
  expect(review.notice).not.toContain('不会显示上一轮');
});

it('settles an older standard-tool main turn and prevents its stale inbox from reopening it', async () => {
  const old = captured('write-capture', 'old-user', now);
  await store.writeRun(old); await store.writeRun(old, true);
  await session([user('old-user', now), reply('old-reply', now + 2000), user('new-user', now + 4000)]);
  await importer.syncSession(sid, root, context());
  expect((await store.getRun(old.id))!).toMatchObject({ state: 'completed', replyMessageId: 'old-reply' });
  await store.importInbox('generation');
  expect((await store.getRun(old.id))!.state).toBe('completed');
  expect((await store.listRuns(false, true)).filter(run => run.state === 'running').map(run => run.userMessageId)).toEqual(['new-user']);
});

it('uses exact tool ownership to repair a stale user binding and deduplicate native and agent records', async () => {
  await session([user('old-user', now), reply('old-reply', now + 2000), user('new-user', now + 4000), tool('new-tool', now + 5000)]);
  await importer.syncSession(sid, root, context());
  const agent = captured('agent-current', 'old-user', now + 4500, ['write:new-tool']);
  await store.writeRun(agent);
  await importer.syncSession(sid, root, context());
  const runs = await store.listRuns(false, true);
  expect(runs.filter(run => run.state === 'running')).toHaveLength(1);
  expect((await store.getRun(agent.id))!).toMatchObject({ userMessageId: 'new-user', state: 'running' });
  expect(await store.getRun(hostHistoryRunId(sid, 'new-user'))).toBeNull();
  expect((await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, context())).runId).toBe(agent.id);
});

it('honors the explicit current identity instead of making a later visible user or child message running', async () => {
  await session([user('old-user', now), user('new-user', now + 4000), tool('new-tool', now + 5000), user('later-user', now + 6000), tool('later-tool', now + 7000), reply('later-reply', now + 8000), { ...user('child-user', now + 9000), meta: { parentMessageId: 'new-tool' } }, tool('child-tool', now + 9100, { parentMessageId: 'new-tool' })]);
  await importer.syncSession(sid, root, context());
  const runs = await store.listRuns(false, true);
  expect(runs.filter(run => run.state === 'running').map(run => run.userMessageId)).toEqual(['new-user']);
  expect((await store.getRun(hostHistoryRunId(sid, 'new-user')))!.changes['native.txt'].evidence).toContain('native:child-tool');
});

it('never imports the previous turn into a new empty capture with a stale user identity', async () => {
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000), user('new-user', now + 4000)]);
  const old = captured('old-main', 'old-user', now);
  const next = { ...captured('new-main', 'old-user', now + 4010), changes: {}, fileCount: 0 };
  await store.writeRun(old); await store.writeRun(next);
  await importer.syncSession(sid, root, context());
  expect((await store.getRun(next.id))!.changes).toEqual({});
  expect((await store.getRun(old.id))!).toMatchObject({ state: 'completed', replyMessageId: 'old-reply' });
});

it('repairs old native recovery pollution using exact new tool ownership without growing the previous turn', async () => {
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000), user('new-user', now + 4000), tool('new-tool', now + 5000)]);
  await importer.syncSession(sid, root, context());
  const old = (await store.getRun(hostHistoryRunId(sid, 'old-user')))!;
  const next = captured('polluted-main', 'old-user', now + 4010, ['write:new-tool']);
  next.changes['native.txt'] = old.changes['native.txt'];
  next.hostRecovery = { captureVersion: 3, files: { 'native.txt': 'legacy-checkpoint' } };
  const oldOnly = { ...old.changes['native.txt'], capture: { ...old.changes['native.txt'].capture!, path: 'old-only.txt', absolutePath: path.join(root, 'old-only.txt'), identity: canonical(path.join(root, 'old-only.txt')), id: digest(canonical(path.join(root, 'old-only.txt'))).slice(0, 24) } };
  old.changes['old-only.txt'] = oldOnly; await store.writeRun(old);
  next.changes['old-only.txt'] = oldOnly; next.hostRecovery!.files!['old-only.txt'] = 'legacy-checkpoint';
  next.replyMessageId = 'old-reply'; next.endedAt = now + 2000; next.state = 'completed';
  await store.writeRun(next);
  for (let i = 0; i < 3; i++) {
    await importer.syncSession(sid, root, context());
    const fixed = (await store.getRun(next.id))!;
    expect(fixed).toMatchObject({ userMessageId: 'new-user', state: 'running' });
    expect(fixed.replyMessageId).toBeUndefined(); expect(fixed.endedAt).toBeUndefined();
    expect(fixed.changes['native.txt'].evidence).toEqual(['native:new-tool']);
    expect(fixed.changes['old-only.txt']).toBeUndefined();
    expect((await store.getRun(old.id))!).toMatchObject({ state: 'completed', fileCount: 2 });
    expect(await store.getRun(hostHistoryRunId(sid, 'new-user'))).toBeNull();
  }
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000), user('new-user', now + 4000), tool('new-tool', now + 5000), reply('new-reply', now + 6000)]);
  await importer.syncSession(sid, root, { running: false });
  const settled = (await store.getRun(next.id))!;
  expect(settled).toMatchObject({ userMessageId: 'new-user', state: 'completed', replyMessageId: 'new-reply', fileCount: 2 });
  await importer.syncSession(sid, root, { running: false });
  expect(await store.getRun(next.id)).toEqual(settled);
  expect((await store.listRuns(false, true)).filter(run => run.state === 'running')).toEqual([]);
});

it('settles every matching capture instead of leaving the second old capture running', async () => {
  await session([user('old-user', now), reply('old-reply', now + 2000), user('new-user', now + 4000)]);
  const captures = [captured('old-a', 'old-user', now), captured('old-b', 'old-user', now + 10)];
  for (const run of captures) { await store.writeRun(run); await store.writeRun(run, true); }
  await importer.syncSession(sid, root, context());
  await store.importInbox('generation');
  for (const run of captures) expect((await store.getRun(run.id))!).toMatchObject({ state: 'completed', replyMessageId: 'old-reply' });
  expect((await store.listRuns(false, true)).filter(run => run.state === 'running').map(run => run.userMessageId)).toEqual(['new-user']);
});

it('does not use a stale identity to merge genuinely mixed tool ownership', async () => {
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000), user('new-user', now + 4000), tool('new-tool', now + 5000)]);
  const mixed = captured('mixed-child', 'old-user', now + 4010, ['write:old-tool', 'write:new-tool']);
  await store.writeRun(mixed);
  await importer.syncSession(sid, root, context());
  expect(Object.keys((await store.getRun(mixed.id))!.changes)).toEqual(['agent.txt']);
  expect((await store.getRun(hostHistoryRunId(sid, 'old-user')))!.state).toBe('completed');
  expect((await store.getRun(hostHistoryRunId(sid, 'new-user')))!.state).toBe('running');
});

it('drops old shell evidence and does not resurrect it from a stale inbox', async () => {
  const old = captured('shell-only', 'old-user', now, ['bash:old-shell']);
  await store.writeRun(old); await store.writeRun(old, true);
  await session([user('old-user', now), reply('old-reply', now + 2000), user('new-user', now + 4000)]);
  await importer.syncSession(sid, root, context());
  expect(await store.getRun(old.id)).toBeNull();
  await store.importInbox('generation');
  expect(await store.getRun(old.id)).toBeNull();
});

it.each(['trusted', 'missing', 'stale', 'idle'] as const)('skips empty current turns with %s activity metadata', async metadata => {
  const old = { ...captured('previous', 'old-user', now), state: 'completed' as const, endedAt: now + 2000 };
  const current = { ...captured('current', 'new-user', now + 4000), changes: {}, fileCount: 0 };
  await store.writeRun(old); await store.writeRun(current);
  const activity = metadata === 'missing' ? undefined : metadata === 'idle' ? { ...context(), running: false } : context(metadata === 'stale' ? 'stale-user' : 'new-user');
  const review = await service.review({ scope: 'lastTurn', sessionId: sid }, false, activity);
  expect(review.runId).toBe(old.id); expect(review.files).toHaveLength(1);
  expect((await store.getRun(current.id))!.changes).toEqual({});
});

it('switches to the current turn on its first modification and retains it after completion', async () => {
  const old = { ...captured('previous', 'old-user', now), state: 'completed' as const, endedAt: now + 2000 };
  const current = captured('current', 'new-user', now + 4000);
  await store.writeRun(old); await store.writeRun({ ...current, changes: {}, fileCount: 0 });
  const request = { scope: 'lastTurn' as const, sessionId: sid };
  expect((await service.review(request, false, context())).runId).toBe(old.id);
  await store.writeRun(current);
  expect((await service.review(request, false, context('stale-user'))).runId).toBe(current.id);
  await store.writeRun({ ...current, state: 'completed', endedAt: now + 6000 });
  expect((await service.review(request, false, { ...context(), running: false })).runId).toBe(current.id);
  await store.writeRun({ ...captured('next-empty', 'next-user', now + 7000), changes: {}, fileCount: 0, state: 'completed', endedAt: now + 8000 });
  expect((await service.review(request, false, { ...context('next-user'), running: false })).runId).toBe(current.id);
});

it('keeps exact historical selection separate from latest-modified selection including empty history', async () => {
  const old = captured('previous', 'old-user', now), current = captured('current', 'new-user', now + 4000);
  await store.writeRun(old); await store.writeRun(current);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid })).runId).toBe(current.id);
  expect((await service.review({ scope: 'turn', sessionId: sid, runId: old.id })).runId).toBe(old.id);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid })).runId).toBe(current.id);
  await store.writeRun({ ...current, changes: {}, fileCount: 0 });
  expect((await service.review({ scope: 'turn', sessionId: sid, runId: current.id })).files).toEqual([]);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid })).runId).toBe(old.id);
});

it('selects across this session roots unless the user explicitly supplies a root filter', async () => {
  const old = captured('previous', 'old-user', now), oldRoot = root;
  await store.writeRun(old);
  root = path.join(temp, 'other-project'); await fs.mkdir(root);
  const current = captured('current', 'new-user', now + 4000); await store.writeRun(current);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid })).runId).toBe(current.id);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid, root: oldRoot })).runId).toBe(old.id);
});

it('does not let image-only turns hide the most recent reviewable changes', async () => {
  const old = captured('previous', 'old-user', now), image = captured('image-turn', 'new-user', now + 4000);
  const absolutePath = path.join(root, 'image.png'), identity = canonical(absolutePath);
  image.changes = { 'image.png': { ...image.changes['agent.txt'], capture: { id: digest(identity).slice(0, 24), identity, absolutePath, origin: 'workspace', path: 'image.png' } } };
  await store.writeRun(old); await store.writeRun(image);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid }, false, context())).runId).toBe(old.id);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid }, false, { ...context(), running: false })).runId).toBe(old.id);
});

it('returns an empty scope only when this session has no reviewable changes, never borrowing another session', async () => {
  await store.writeRun({ ...captured('other-session', 'other-user', now + 8000), sessionId: 'another-session' });
  await store.writeRun({ ...captured('empty', 'new-user', now + 4000), changes: {}, fileCount: 0 });
  const review = await service.review({ scope: 'lastTurn', sessionId: sid }, false, context());
  expect(review.files).toEqual([]); expect(review.runId).toBeUndefined();
  await expect(service.review({ scope: 'lastTurn' })).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
});
