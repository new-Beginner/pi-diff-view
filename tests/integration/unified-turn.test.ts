import { publicSessionContext } from '../../src/core/public-session-context';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HostHistoryImporter, hostHistoryRunId } from '../helpers/history-fixture';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import { hostEvidenceMessages } from '../../src/core/host-transcript';
import { runningActivity } from '../../src/renderer/plugin-review-adapter';
import type { CaptureRun } from '../../src/core/contracts';
let temp: string, root: string, host: string, store: SnapshotStore, importer: HostHistoryImporter, service: ReviewService;
const sid = 'session-one', t = Date.now() - 10000;
const row = (id: string, role: string, order: number, blocks: any[] = [], meta: any = {}) => ({ type: 'message', id, role, createdAt: t + order, blocks, meta: { status: 'complete', ...meta } });
const user = (id = 'user-one', order = 0) => row(id, 'user', order);
const reply = (id = 'reply-one', order = 5, status = 'complete') => row(id, 'assistant', order, [{ type: 'text' }], { status });
const task = (id: string, order: number, status = 'running', parent?: string) => row(id, 'tool', order, [{ type: 'tool_call', callId: id, name: 'Task', status: 'success', result: { details: { delegationId: `d-${id}`, status, startedAt: t + order, ...(status !== 'running' ? { completedAt: t + 20 } : {}) } } }], parent ? { parentMessageId: parent } : {});
const edit = (id: string, order: number, parent?: string) => row(id, 'tool', order, [{ type: 'tool_call', callId: id, name: 'Edit', args: { path: 'a.txt' }, status: 'success' }], parent ? { parentMessageId: parent } : {});
async function session(rows: any[], sessionId = sid) { await fs.mkdir(path.join(host, 'sessions'), { recursive: true }); await fs.writeFile(path.join(host, 'sessions', `${sessionId}.jsonl`), [{ type: 'session', sessionId }, ...rows].map(r => JSON.stringify(r)).join('\n')); }
async function evidence(id: string, before: string, after: string, sessionId = sid) { const dir = path.join(host, 'review-changes', sessionId, id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId, messageId: id, path: 'a.txt', operation: 'edit', beforeExists: true, afterExists: true, beforeHash: digest(before), afterHash: digest(after) })); await fs.writeFile(path.join(dir, 'before'), before); await fs.writeFile(path.join(dir, 'after'), after); }
const get = (u = 'user-one', s = sid) => store.getRun(hostHistoryRunId(s, u));
beforeEach(async () => { temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'unified-turn-')); root = path.join(temp, 'workspace'); host = path.join(temp, 'host'); store = new SnapshotStore(path.join(temp, 'data')); await store.init(); importer = new HostHistoryImporter(store, host); service = new ReviewService(store, { workspace: async () => ({ path: root }), appearance: async () => ({}), settings: async () => ({}), setSettings: async () => {}, clipboard: async () => {}, openPanel: async () => {} }, 'generation'); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
it('keeps a single parent running until every child settles, then uses the actual outcome', async () => {
  await evidence('main-edit', 'original\n', 'main\n'); await evidence('child-edit', 'main\n', 'child\nextra\n');
  const rows = [user(), task('task-a', 1), task('task-b', 2, 'completed'), edit('main-edit', 3), reply(), edit('child-edit', 9, 'task-a')];
  await session(rows); await importer.syncSession(sid, root, { running: true, mainRunning: false, statusKnown: true, taskId: 'user-one', since: t });
  const run = (await get())!; expect(run.state).toBe('running'); expect((await service.bootstrap(sid)).runs).toHaveLength(1); expect((await service.replyCards({ sessionId: sid })).cards).toEqual([]);
  expect(await service.runningChanges({ sessionId: sid, since: t, taskId: 'user-one' })).toMatchObject({ runId: run.id, fileCount: 1, additions: 2, deletions: 1 });
  rows[1] = task('task-a', 1, 'failed'); await session(rows); await importer.syncSession(sid, root, { running: true, mainRunning: false, taskId: 'user-one', since: t });
  expect((await get())!.state).toBe('incomplete'); expect((await service.turnSummary({ sessionId: sid, runId: run.id })).files).toHaveLength(1);
  expect((await get())!.changes['a.txt'].before.text).toBe('original\n'); expect((await get())!.changes['a.txt'].after.text).toBe('child\nextra\n');
});
it('child early completion does not end the main; interrupt keeps pending children running and finishes aborted', async () => {
  await evidence('edit', 'old\n', 'new\n'); const rows = [user(), task('a', 1, 'completed'), task('b', 2), edit('edit', 3), reply('aborted', 5, 'aborted')]; await session(rows);
  await importer.syncSession(sid, root, { running: true, taskId: 'user-one', since: t }); expect((await get())!.state).toBe('running');
  await importer.syncSession(sid, root, { running: false }); expect((await get())!.state).toBe('running');
  rows[2] = task('b', 2, 'stopped'); await session(rows); await importer.syncSession(sid, root, { running: false }); expect((await get())!.state).toBe('aborted');
});
it('late children stay in the launch turn across newer users, sessions and reloads', async () => {
  await evidence('old-edit', 'old\n', 'old changed\n'); await evidence('new-edit', 'old changed\n', 'new changed\n');
  await session([user(), task('a', 1), reply(), user('user-two', 6), edit('new-edit', 7), reply('reply-two', 8), edit('old-edit', 9, 'a')]);
  await session([user(), task('a', 1, 'completed'), reply()], 'session-two');
  await importer.syncSession(sid, root, { running: false }); await importer.syncSession('session-two', root, { running: false });
  expect((await get())!.state).toBe('running'); expect((await get())!.changes['a.txt'].after.text).toBe('old changed\n'); expect((await get('user-two'))!.changes['a.txt'].after.text).toBe('new changed\n');
  expect(await new HostHistoryImporter(store, host).syncSession(sid, root, { running: false })).toMatchObject({ unchanged: 2 });
  expect((await get('user-one', 'session-two'))?.changes ?? {}).not.toHaveProperty('a.txt');
});
it('coalesces verified runner records and computes one net delta instead of adding partial totals', async () => {
  await evidence('main', 'original\n', 'middle\n'); await evidence('child', 'middle\n', 'original\n');
  await session([user(), task('a', 1, 'completed'), edit('main', 2), edit('child', 3, 'a'), reply()]);
  for (const [id, call, before, after, startedAt] of [['main-run', 'main', 'original\n', 'middle\n', t], ['child-run', 'child', 'middle\n', 'original\n', t + 1]] as const) {
    const absolutePath = path.join(root, 'a.txt'), identity = canonical(absolutePath);
    const run: CaptureRun = { version: 2, id, root, sessionId: sid, generation: 'generation', userMessageId: 'user-one', boundary: 'user', startedAt, state: 'completed', incomplete: false, fileCount: 1, replies: [], bindings: {}, changes: { 'a.txt': { capture: { id: digest(identity).slice(0, 24), identity, path: 'a.txt', origin: 'workspace', absolutePath }, before: snapshotOfText(before), after: snapshotOfText(after), evidence: [`edit:${call}`] } } }; await store.writeRun(run);
  }
  await importer.syncSession(sid, root, { running: false }); expect(await store.listRuns()).toHaveLength(1);
  const run = (await get())!; expect(run.id).toBe('main-run'); expect(await store.getRun('child-run')).toMatchObject({ id: 'main-run' });
  expect(await service.turnSummary({ runId: run.id, sessionId: sid })).toMatchObject({ fileCount: 1, additions: 0, deletions: 0 });
});
it('does not turn overlapping or discontinuous endpoints into an automatic merge', async () => {
  await session([user(), task('a', 1, 'completed'), edit('one', 2), edit('two', 3, 'a'), reply()]); await evidence('one', 'original\n', 'first\n'); await evidence('two', 'original\n', 'second\n');
  await importer.syncSession(sid, root, { running: false }); const run = (await get())!;
  expect(run.changes['a.txt'].ambiguous).toBe(true); expect(await service.turnSummary({ sessionId: sid, runId: run.id })).toMatchObject({ additions: 0, deletions: 0, unknownFileCount: 1 });
});
it('keeps only safe delegation lifecycle metadata and follows the launch owner while the main is idle', () => {
  const messages = [{ id: 'u', role: 'user', createdAt: t }, { id: 'task-row', role: 'tool', createdAt: t + 1, toolCallId: 'task', toolName: 'Task', toolStatus: 'success', toolArgs: { task: 'SECRET' }, toolResult: { details: { delegationId: 'd', status: 'running', startedAt: t + 1, report: 'SECRET', agent: 'fixer' } } }, { id: 'u2', role: 'user', createdAt: t + 2 }];
  const normalized = hostEvidenceMessages(messages); expect(normalized[1].blocks[0].result.details).toMatchObject({ delegationId: 'd', status: 'running', startedAt: t + 1 }); expect(JSON.stringify(normalized)).not.toContain('SECRET');
  expect(runningActivity(publicSessionContext({ sessionId: sid, running: false, statusKnown: true, complete: true, messages: normalized }))).toMatchObject({ sessionId: sid, taskId: 'u', since: t });
});

it('retains late aliased source endpoints without a duplicate entry or leaking into a newer USER', async () => {
  await evidence('main', 'original\n', 'middle\n'); await evidence('child', 'middle\n', 'original\n');
  await session([user(), task('a', 1), edit('main', 2), edit('child', 3, 'a'), reply()]);
  const absolutePath = path.join(root, 'a.txt'), identity = canonical(absolutePath);
  const source: CaptureRun = { version: 2, id: 'child-source', root, sessionId: sid, generation: 'generation', userMessageId: 'user-one', boundary: 'user', startedAt: t + 1, state: 'running', contentVersion: 1, incomplete: false, fileCount: 1, replies: [], bindings: {}, changes: { 'a.txt': { capture: { id: digest(identity).slice(0, 24), identity, path: 'a.txt', origin: 'workspace', absolutePath }, before: snapshotOfText('middle\n'), after: snapshotOfText('original\n'), evidence: ['edit:child'] } } };
  await store.writeRun(source);
  await importer.syncSession(sid, root, { running: false });
  const originalId = (await get())!.id;
  // A second original capture makes the source a retired alias, while its writer is live.
  await store.writeRun({ ...source, id: 'parent-source', startedAt: t, contentVersion: 1, changes: { 'a.txt': { ...source.changes['a.txt'], before: snapshotOfText('original\n'), after: snapshotOfText('middle\n'), evidence: ['edit:main'] } } });
  await importer.syncSession(sid, root, { running: false });
  expect((await store.getRun('child-source'))!.id).toBe('parent-source');
  source.contentVersion = 2; source.changes['a.txt'] = { ...source.changes['a.txt'], after: snapshotOfText('late\nextra\n'), evidence: ['edit:child', 'edit:late'] };
  await store.writeRun(source, true); await store.importInbox('generation');
  const late = edit('late', 9, 'a'); late.blocks[0].result = { details: { review: { version: 1, messageId: 'late', path: 'a.txt', beforeExists: true, afterExists: true, beforeHash: digest('original\n'), afterHash: digest('late\nextra\n') } } } as any;
  await session([user(), task('a', 1, 'completed'), edit('main', 2), edit('child', 3, 'a'), reply(), user('user-two', 6), reply('reply-two', 8), late]);
  await importer.syncSession(sid, root, { running: false });
  const unified = (await get())!; expect(unified.id).toBe('parent-source'); expect((await store.getRun(originalId))!.id).toBe(unified.id);
  expect(unified.changes['a.txt'].before.text).toBe('original\n'); expect(unified.changes['a.txt'].after.text).toBe('late\nextra\n');
  expect((await get('user-two'))?.changes ?? {}).not.toHaveProperty('a.txt'); expect(await store.listRuns()).toHaveLength(1);
  expect(await service.turnSummary({ runId: unified.id, sessionId: sid })).toMatchObject({ fileCount: 1, additions: 2, deletions: 1 });
});

it.each([false, true])('coalesces direct USER-bound endpoints before native tool history is flushed (conflict: %s)', async conflict => {
  await session([user(), task('a', 1, 'completed'), reply()]);
  const absolutePath = path.join(root, 'a.txt'), identity = canonical(absolutePath);
  for (const [id, startedAt, before, after, call] of [['main-capture', t, 'original\n', 'middle\n', 'unflushed-main'], ['child-capture', t + 1, conflict ? 'original\n' : 'middle\n', 'last\nextra\n', 'unflushed-child']] as const) {
    await store.writeRun({ version: 2, id, root, sessionId: sid, generation: 'generation', userMessageId: 'user-one', boundary: 'user', startedAt, state: 'completed', incomplete: false, fileCount: 1, replies: [], bindings: {}, changes: { 'a.txt': { capture: { id: digest(identity).slice(0, 24), identity, path: 'a.txt', origin: 'workspace', absolutePath }, before: snapshotOfText(before), after: snapshotOfText(after), evidence: [`edit:${call}`] } } });
  }
  await importer.syncSession(sid, root, { running: false }); const run = (await get())!;
  expect(await store.listRuns()).toHaveLength(1); expect(Object.keys(run.changes)).toEqual(['a.txt']);
  expect(run.changes['a.txt'].before.text).toBe('original\n');
  const summary = await service.turnSummary({ sessionId: sid, runId: run.id });
  if (conflict) { expect(run.changes['a.txt'].ambiguous).toBe(true); expect(summary).toMatchObject({ unknownFileCount: 1, additions: 0, deletions: 0 }); }
  else { expect(run.changes['a.txt'].after.text).toBe('last\nextra\n'); expect(summary).toMatchObject({ fileCount: 1, additions: 2, deletions: 1 }); }
});
