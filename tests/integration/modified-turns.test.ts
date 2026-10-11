import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let root: string, store: SnapshotStore, service: ReviewService;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-modified-turns-'));
  store = new SnapshotStore(path.join(root, 'data')); await store.init();
  service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, 'generation');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function recorded(startedAt: number, overrides: Partial<CaptureRun> = {}): CaptureRun {
  return { version: 1, id: randomUUID(), generation: 'generation', sessionId: 's', root, startedAt, state: 'completed', incomplete: false, fileCount: 1, changes: { 'a.txt': { before: snapshotOfText('before\n'), after: snapshotOfText('after\n') } }, replies: [], bindings: {}, ...overrides };
}

describe('modified-turn history', () => {
  it('skips legacy empty/no-op turns, even with stale fileCount, and preserves session/root selection', async () => {
    const changed = recorded(1), otherSession = recorded(5, { sessionId: 'other' }), otherRoot = recorded(6, { root: path.join(root, 'other') });
    for (const run of [changed, otherSession, otherRoot]) await store.writeRun(run);
    for (const run of [recorded(10, { changes: {} }), recorded(11, { changes: { 'a.txt': { before: snapshotOfText('same'), after: snapshotOfText('same') } } })]) {
      // Simulate records made before empty-turn filtering was introduced.
      await atomicJson(path.join(store.directory, 'runs', `${run.id}.json`), run);
    }
    expect((await store.listRuns(false)).map(run => run.id)).toEqual([otherRoot.id, otherSession.id, changed.id]);
    expect((await service.bootstrap('s')).runs.map(run => run.id)).toEqual([otherRoot.id, changed.id]);
    expect((await service.review({ scope: 'lastTurn', sessionId: 's', root })).runId).toBe(changed.id);
    expect((await service.review({ scope: 'lastTurn', sessionId: 's' })).runId).toBe(otherRoot.id);
    expect((await service.review({ scope: 'lastTurn', sessionId: 'other', root })).runId).toBe(otherSession.id);
    expect((await service.review({ scope: 'lastTurn', sessionId: 'missing', root })).files).toEqual([]);
  });

  it.each(['completed', 'incomplete', 'aborted'] as const)('removes both copies when a changed turn becomes empty and %s', async state => {
    const run = recorded(1, { state: 'running' }); await store.writeRun(run, true); await store.importInbox('generation');
    run.changes['a.txt'].after = run.changes['a.txt'].before; run.state = state;
    await store.writeRun(run, true);
    expect(await store.getRun(run.id, true)).toBeNull(); expect(await store.getRun(run.id)).toBeNull();
    expect(await store.listRuns()).toEqual([]);
  });

  it('keeps only a hidden active marker, including across pruning, and removes it on stale-generation import', async () => {
    const run = recorded(1, { state: 'running', changes: {}, prompt: 'private dialogue', replies: [{ hash: 'reply', timestamp: 1 }], finalReply: { hash: 'reply', timestamp: 1 }, bindings: { reply: 'message' } });
    await store.writeRun(run, true); await store.importInbox('generation');
    expect((await service.bootstrap('s')).runs).toEqual([]);
    expect((await service.review({ scope: 'lastTurn', sessionId: 's', root })).runId).toBeUndefined();
    const marker = await store.getRun(run.id, false, false);
    expect(marker).toMatchObject({ state: 'running', fileCount: 0, changes: {}, replies: [], bindings: {} });
    expect(marker?.prompt).toBeUndefined(); expect(marker?.finalReply).toBeUndefined();
    expect(await fs.readdir(path.join(store.directory, 'blobs'))).toEqual([]);
    await store.prune(); expect(await store.getRun(run.id)).not.toBeNull();
    await expect(service.invoke('clearHistory', { confirmed: true })).rejects.toThrow('Stop active');
    await store.importInbox('new-generation');
    expect(await store.getRun(run.id)).toBeNull(); expect(await store.getRun(run.id, true)).toBeNull();
  });

  it('counts mode-only changes even when text does not change', async () => {
    const run = recorded(1, { fileCount: 0, changes: { 'a.txt': { before: snapshotOfText('same', 0o644), after: snapshotOfText('same', 0o755) } } });
    await store.writeRun(run);
    expect((await service.bootstrap('s')).runs[0].fileCount).toBe(1);
    expect((await service.review({ scope: 'lastTurn', sessionId: 's', root })).files[0].status).toBe('mode');
  });
});
