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
function captured(id: string, userMessageId: string, startedAt: number, evidence: string[] = ['bash:old-shell']): CaptureRun {
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

it('selects the empty current turn from trusted identity before JSONL flush, never reopens the previous turn', async () => {
  await session([user('old-user', now), tool('old-tool', now + 1000), reply('old-reply', now + 2000)]);
  await importer.syncSession(sid, root);
  const activity = context();
  await importer.syncSession(sid, root, activity);
  expect((await store.getRun(hostHistoryRunId(sid, 'old-user')))!.state).toBe('completed');
  const review = await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, activity);
  expect(review.run).toMatchObject({ id: hostHistoryRunId(sid, 'new-user'), state: 'running', fileCount: 0 });
  expect(review.files).toEqual([]);
  expect((await service.bootstrap(sid)).runs.filter(run => run.state === 'running')).toHaveLength(1);
  await importer.syncSession(sid, root, { running: false });
  expect((await store.listRuns(false, true)).filter(run => run.state === 'running')).toEqual([]);
  expect((await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, { ...activity, running: false })).runId).toBe(hostHistoryRunId(sid, 'old-user'));
});

it('does not substitute any previous changes when the current identity has no capture yet', async () => {
  await store.writeRun(captured('older-capture', 'old-user', now));
  const review = await service.review({ scope: 'lastTurn', sessionId: sid, root }, false, context());
  expect(review.files).toEqual([]); expect(review.runId).toBeUndefined();
  expect(review.notice).toContain('当前轮次');
});

it('settles an older shell-only main turn and prevents its stale inbox from reopening it', async () => {
  const old = captured('shell-capture', 'old-user', now);
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
