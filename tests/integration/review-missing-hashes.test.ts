import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../../src/core/storage';
import { HostHistoryImporter } from '../../src/core/host-history';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let temp: string, root: string, store: SnapshotStore;
const sessionId = 'missing-hashes', userMessageId = 'user';
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'review-hashes-'));
  root = path.join(temp, 'project'); await fs.mkdir(root);
  store = new SnapshotStore(path.join(temp, 'store')); await store.init();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });
function messages(name: string, args: object, review: object) {
  return [
    { type: 'message', id: userMessageId, role: 'user', createdAt: 1, blocks: [] },
    { type: 'message', id: 'call', role: 'tool', createdAt: 2, blocks: [{ type: 'tool_call', callId: 'call', name, args: { path: 'a.txt', ...args }, status: 'success', result: { details: { review: { version: 1, messageId: 'call', path: 'a.txt', operation: name.toLowerCase(), ...review } } } }] },
  ];
}
async function sync(rows: unknown[]) {
  await new HostHistoryImporter(store).syncSession(sessionId, root, { messages: rows, statusKnown: false });
  return (await store.listRuns(false, true))[0];
}
async function captured(beforeText: string, afterText: string, { blob = true, duplicate = false, refs = ['edit:call'] } = {}) {
  const identity = canonical(path.join(root, 'a.txt'));
  const before = snapshotOfText(beforeText), after = snapshotOfText(afterText);
  if (blob) await store.saveBlob(before);
  const change = { capture: { id: digest(identity).slice(0, 24), identity, path: 'a.txt', absolutePath: path.join(root, 'a.txt'), origin: 'workspace' as const }, before: { ...before, text: null, kind: 'unavailable' as const }, after: { ...after, text: null, kind: 'unavailable' as const }, ambiguous: true, evidence: refs };
  const run: CaptureRun = { version: 2, id: 'capture', sessionId, userMessageId, root, generation: 'g', state: 'completed', boundary: 'user', startedAt: 1, endedAt: 3, incomplete: true, fileCount: 1, changes: { 'a.txt': change }, replies: [], bindings: {} };
  await store.writeRun(run);
  if (duplicate) await store.writeRun({ ...run, id: 'conflicting-capture', changes: { 'a.txt': { ...change, after: { ...change.after, hash: digest('conflicting\n') } } } });
}
it('recovers an added Write with a review lacking hashes and remains stable on repeated imports', async () => {
  const rows = messages('Write', { content: 'new\n' }, { status: 'added' });
  const first = await sync(rows);
  expect(first.changes['a.txt'].before).toMatchObject({ kind: 'text', exists: false });
  expect((await store.hydrate(first.changes['a.txt'].after)).text).toBe('new\n');
  const next = await sync(rows);
  expect(next.contentVersion).toBe(first.contentVersion);
});
it('does not assume a Write with unknown prior existence created an empty file', async () => {
  const run = await sync(messages('Write', { content: 'new\n' }, { status: 'modified' }));
  expect(run.changes['a.txt'].before.kind).toBe('unavailable');
  expect((await store.hydrate(run.changes['a.txt'].after)).text).toBe('new\n');
});
it('reconstructs an Edit only from exact captured endpoint hashes and a retained preimage blob', async () => {
  await captured('old\n', 'new\n');
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((file: any, ...args: any[]) => {
    if (canonical(String(file)) === canonical(path.join(root, 'a.txt'))) throw new Error('Must not read current file');
    return (read as any)(file, ...args);
  }) as any);
  const rows = messages('Edit', { tag: digest('old\n').slice(-4).toUpperCase(), ops: 'PUT 1.=1:\n+new' }, { status: 'modified' });
  const run = await sync(rows);
  expect(run.changes['a.txt'].ambiguous).not.toBe(true);
  expect((await store.hydrate(run.changes['a.txt'].before)).text).toBe('old\n');
  expect((await store.hydrate(run.changes['a.txt'].after)).text).toBe('new\n');
  expect((await sync(rows)).contentVersion).toBe(run.contentVersion);
});
it.each(['no blob', 'wrong result', 'unlinked call', 'conflicting hashes'])('does not promote an uncertain Edit with %s', async reason => {
  await captured('old\n', reason === 'wrong result' ? 'other\n' : 'new\n', { blob: reason !== 'no blob', refs: reason === 'unlinked call' ? ['edit:unrelated'] : ['edit:call'], duplicate: reason === 'conflicting hashes' });
  const run = await sync(messages('Edit', { tag: digest('old\n').slice(-4).toUpperCase(), ops: 'PUT 1.=1:\n+new' }, { status: 'modified' }));
  expect(run.changes['a.txt'].ambiguous).toBe(true);
});
it('does not override a supplied mismatching native result hash', async () => {
  const run = await sync(messages('Write', { content: 'new\n' }, { status: 'added', afterHash: digest('different\n') }));
  expect(run.changes['a.txt'].after.kind).toBe('unavailable');
});
it('does not reconstruct a review with a mismatched tool identity', async () => {
  const run = await sync(messages('Write', { content: 'new\n' }, { status: 'added', messageId: 'another-call' }));
  expect(run).toBeUndefined();
});
it('uses exact successful Edit arguments when review metadata has been clipped to hunks only', async () => {
  await captured('old\n', 'new\n');
  const rows = messages('Edit', { tag: digest('old\n').slice(-4).toUpperCase(), ops: 'PUT 1.=1:\n+new' }, {});
  rows[1].blocks[0].result.details.review = { hunks: [] } as any;
  const run = await sync(rows);
  expect(run.changes['a.txt'].ambiguous).not.toBe(true);
  expect((await store.hydrate(run.changes['a.txt'].after)).text).toBe('new\n');
});
it('does not trust two sampled blobs unless the successful tool reproduces the recorded output', async () => {
  await captured('old\n', 'new\n'); await store.saveBlob(snapshotOfText('new\n'));
  const run = await sync(messages('Edit', { tag: digest('old\n').slice(-4).toUpperCase(), ops: 'PUT 1.=1:\n+unrelated' }, { status: 'modified' }));
  expect(run.changes['a.txt'].ambiguous).toBe(true);
});
