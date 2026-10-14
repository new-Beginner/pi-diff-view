import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SnapshotStore } from '../../src/core/storage';
import { HostHistoryImporter, hostHistoryRunId } from '../../src/core/host-history';
import { absentSnapshot, canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let temp: string, host: string, root: string, sid: string, store: SnapshotStore;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'history-endpoints-'));
  host = path.join(temp, 'data'); sid = randomUUID(); root = path.join(host, 'scratch', sid);
  store = new SnapshotStore(path.join(host, 'plugins', 'data', 'diff-view'));
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(path.join(host, 'sessions'), { recursive: true }); await store.init();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

async function seed(polluted = false, tag = digest('old\n').slice(-4).toUpperCase(), afterText = 'new\n', gap = false) {
  const file = path.join(root, 'a.txt'), identity = canonical(file);
  const capture = { id: digest(identity).slice(0, 24), identity, path: 'a.txt', absolutePath: file, origin: 'workspace' as const };
  const before = gap ? snapshotOfText('other\n') : absentSnapshot();
  const rows = [
    { type: 'session', sessionId: sid, schema: 1 },
    { type: 'message', id: 'user', role: 'user', createdAt: 1, blocks: [], meta: { status: 'complete' } },
    { type: 'message', id: 'write', role: 'tool', createdAt: 2, blocks: [{ type: 'tool_call', callId: 'write', name: 'Write', args: { path: file, content: 'old\n' }, status: 'success', result: { isError: false } }], meta: { status: 'complete' } },
    { type: 'message', id: 'edit', role: 'tool', createdAt: 3, blocks: [{ type: 'tool_call', callId: 'edit', name: 'Edit', args: { path: file, tag, ops: 'PUT 1.=1:\n+new' }, status: 'success', result: { isError: false } }], meta: { status: 'complete' } },
    { type: 'message', id: 'reply', role: 'assistant', createdAt: 4, blocks: [], meta: { status: 'complete' } },
  ];
  await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n'));
  const run: CaptureRun = {
    version: 2, id: hostHistoryRunId(sid, 'user'), source: 'host-history', generation: randomUUID(),
    sessionId: sid, root, startedAt: 1, endedAt: 4, state: 'completed', boundary: 'user', userMessageId: 'user', replyMessageId: 'reply',
    fileCount: 1, incomplete: polluted || gap, replies: [], bindings: {}, changes: { 'a.txt': {
      capture, before: absentSnapshot(), after: snapshotOfText(afterText), evidence: ['native:write', 'native:edit'],
      ...(polluted || gap ? { ambiguous: true, segments: [
        { evidence: 'native:write', before: absentSnapshot(), after: snapshotOfText('old\n') },
        { evidence: 'native:edit', before, after: snapshotOfText(afterText) },
      ] } : {}),
    } },
  };
  await store.writeRun(run);
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((p: any, ...args: any[]) => {
    if (canonical(String(p)) === identity) throw new Error('Never recover from current file');
    return (read as any)(p, ...args);
  }) as any);
  return new HostHistoryImporter(store, host);
}

it.each([false, true])('keeps Write → Edit continuous across repeated imports (polluted: %s)', async polluted => {
  const importer = await seed(polluted);
  let version: number | undefined;
  for (let index = 0; index < 3; index++) {
    await importer.syncSession(sid, root);
    const run = (await store.getRun(hostHistoryRunId(sid, 'user')))!;
    const change = run.changes['a.txt'];
    expect(change.ambiguous).not.toBe(true);
    expect(run.incomplete).toBe(false);
    expect(change.before.exists).toBe(false);
    expect(change.after.text).toBe('new\n');
    expect(change.segments?.[1].before).toMatchObject({ exists: true, hash: digest('old\n'), text: 'old\n' });
    if (version !== undefined) expect(run.contentVersion).toBe(version);
    version = run.contentVersion;
  }
});

it.each([
  ['wrong tag', '0000', 'new\n'],
  ['missing tag', undefined, 'new\n'],
  ['wrong result hash', digest('old\n').slice(-4).toUpperCase(), 'unrelated\n'],
])('does not infer an Edit start with %s', async (_label, tag, afterText) => {
  const importer = await seed(true, tag === undefined ? '' : tag, afterText);
  await importer.syncSession(sid, root);
  const change = (await store.getRun(hostHistoryRunId(sid, 'user')))!.changes['a.txt'];
  expect(change.segments?.[1].before.kind).toBe('unavailable');
});

it('preserves a real discontinuity with a verified existing Edit start', async () => {
  const importer = await seed(false, digest('other\n').slice(-4).toUpperCase(), 'new\n', true);
  for (let index = 0; index < 2; index++) {
    await importer.syncSession(sid, root);
    const change = (await store.getRun(hostHistoryRunId(sid, 'user')))!.changes['a.txt'];
    expect(change.ambiguous).toBe(true);
    expect(change.segments?.[1].before.text).toBe('other\n');
  }
});
