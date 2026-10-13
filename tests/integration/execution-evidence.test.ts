import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../../src/core/storage';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';
it.each([true, false])('requires exact lifecycle evidence with native recovery=%s and preserves reply binding', async recovered => {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'execution-evidence-'));
  const store = new SnapshotStore(dir); await store.init();
  const file = path.join(dir, 'project', 'a.txt'), identity = canonical(file);
  const run: CaptureRun = { version: 2, id: 'run-one', sessionId: 's1', root: path.dirname(file), generation: 'generation', contentVersion: 3, boundary: 'user', userMessageId: 'user-one', state: 'completed', endedAt: 200, startedAt: 100, incomplete: false, fileCount: 1, execution: { id: 'runner-one', revision: 2, state: 'settled' }, ...(recovered ? { hostRecovery: { captureVersion: 2 } } : {}), finalReply: { hash: digest('reply'), timestamp: 200 }, replies: [{ hash: digest('reply'), timestamp: 200 }], bindings: { reply: 'message-one' }, changes: { 'a.txt': { capture: { id: digest(identity).slice(0, 24), identity, absolutePath: file, path: 'a.txt', origin: 'workspace' }, before: snapshotOfText('old'), after: snapshotOfText('new') } } };
  try {
    await store.writeRun(run);
    await store.writeRun({ ...run, contentVersion: 4, state: 'running', endedAt: undefined, execution: { id: 'runner-one', revision: 1, state: 'running' } }, true); await store.importInbox('generation');
    expect((await store.getRun(run.id))!.state).toBe('completed');
    await store.writeRun({ ...run, contentVersion: 5, finalReply: undefined, bindings: {}, state: 'running', endedAt: undefined, execution: undefined }, true); await store.importInbox('generation');
    expect((await store.getRun(run.id))!).toMatchObject({ state: 'completed', finalReply: run.finalReply, bindings: run.bindings });
    await store.writeRun({ ...run, sessionId: 'foreign-session', contentVersion: 100 }, true); await store.importInbox('generation');
    expect((await store.getRun(run.id))!.sessionId).toBe('s1');
    await store.writeRun({ ...run, contentVersion: 6, state: 'running', endedAt: undefined, execution: { id: 'runner-one', revision: 3, state: 'running' } }, true); await store.importInbox('generation');
    expect((await store.getRun(run.id))!).toMatchObject({ state: 'running', execution: { revision: 3 } });
    await store.writeRun({ ...run, contentVersion: 4 }, true); await store.importInbox('generation');
    expect((await store.getRun(run.id))!.state).toBe('running');
    await store.writeRun({ ...run, id: 'independent', sessionId: 's2', state: 'running', endedAt: undefined, execution: { id: 'runner-two', revision: 1, state: 'running' } });
    expect((await store.getRun('independent'))!.state).toBe('running');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
