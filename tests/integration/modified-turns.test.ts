import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotFromBytes, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let root: string, store: SnapshotStore, service: ReviewService;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-modified-turns-'));
  store = new SnapshotStore(path.join(root, 'data')); await store.init();
  service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, 'generation');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function recorded(startedAt: number, overrides: Partial<CaptureRun> = {}): CaptureRun {
  const run: CaptureRun = { version: 1, id: randomUUID(), generation: 'generation', sessionId: 's', root, startedAt, state: 'completed', incomplete: false, fileCount: 1, changes: { 'a.txt': { before: snapshotOfText('before\n'), after: snapshotOfText('after\n') } }, replies: [], bindings: {}, ...overrides };
  if (run.version === 2) for (const [value, change] of Object.entries(run.changes)) {
    const absolutePath = path.resolve(run.root, value), identity = canonical(absolutePath);
    change.capture = { id: digest(identity).slice(0, 24), identity, absolutePath, path: value, origin: 'workspace' };
  }
  return run;
}

describe('modified-turn history', () => {
  it('imports a completed tool snapshot directly and reuses unchanged review identity', async () => {
    const run = recorded(1, { version: 2, boundary: 'user', state: 'running' });
    await store.writeRun(run, true);
    const request = { scope: 'lastTurn' as const, sessionId: 's', root };
    const first = await service.review(request);
    expect(first.files[0]).toMatchObject({ statsKnown: true, additions: 1, deletions: 1 });
    expect((await service.review(request)).id).toBe(first.id);
    run.changes['a.txt'].after = snapshotOfText('after\nmore\n');
    await store.writeRun(run, true);
    const changed = await service.review(request);
    expect(changed.id).not.toBe(first.id); expect(changed.files[0].additions).toBe(2);
    expect((await service.file({ reviewId: changed.id, fileId: changed.files[0].id })).hunks.flatMap(h => h.lines).some(line => line.text === 'more')).toBe(true);
  });
  it('accepts exact host-recovered user identity across reloads but not arbitrary old-generation captures', async () => {
    const run = recorded(1, { version: 2, boundary: 'user', userMessageId: 'current-user', state: 'running', generation: 'old-generation' });
    await store.writeRun(run);
    expect(await service.runningChanges({ sessionId: 's', taskId: 'current-user', since: 0 })).toBeNull();
    run.hostRecovery = { captureVersion: 1 }; await store.writeRun(run);
    await store.writeRun(recorded(2, { version: 2, boundary: 'uncertain', state: 'running', changes: {} }));
    expect(await service.runningChanges({ sessionId: 's', taskId: 'current-user', since: 0 })).toMatchObject({ runId: run.id, additions: 1, deletions: 1 });
    expect(await service.runningChanges({ sessionId: 's', taskId: 'another-user', since: 0 })).toBeNull();
  });
  it('skips truly empty legacy turns but retains recorded net-zero entries without evidence', async () => {
    const changed = recorded(1), otherSession = recorded(5, { sessionId: 'other' }), otherRoot = recorded(6, { root: path.join(root, 'other') });
    for (const run of [changed, otherSession, otherRoot]) await store.writeRun(run);
    const netZero = recorded(11, { changes: { 'a.txt': { before: snapshotOfText('same'), after: snapshotOfText('same') } } });
    for (const run of [recorded(10, { changes: {} }), netZero]) {
      // A stored changes entry is retained even when a legacy record has no tool evidence.
      await atomicJson(path.join(store.directory, 'runs', `${run.id}.json`), run);
    }
    expect((await store.listRuns(false)).map(run => run.id)).toEqual([netZero.id, otherRoot.id, otherSession.id, changed.id]);
    expect((await service.bootstrap('s')).runs.map(run => run.id)).toEqual([netZero.id, otherRoot.id, changed.id]);
    const review = await service.review({ scope: 'lastTurn', sessionId: 's', root }); expect(review.runId).toBe(netZero.id);
    expect(review.files[0]).toMatchObject({ additions: 0, deletions: 0, actions: [] }); expect(review.files[0].note).toContain('净变化为零');
    expect((await service.review({ scope: 'lastTurn', sessionId: 's' })).runId).toBe(netZero.id);
    expect((await service.review({ scope: 'lastTurn', sessionId: 'other', root })).runId).toBe(otherSession.id);
    expect((await service.review({ scope: 'lastTurn', sessionId: 'missing', root })).files).toEqual([]);
  });

  it.each(['completed', 'incomplete', 'aborted'] as const)('retains changed-then-restored records when %s; removes only truly empty records', async state => {
    const run = recorded(1, { state: 'running' }); await store.writeRun(run, true); await store.importInbox('generation');
    run.changes['a.txt'].after = run.changes['a.txt'].before; run.state = state;
    await store.writeRun(run, true);
    expect((await store.getRun(run.id, true))?.changes['a.txt'].diffStats).toMatchObject({ additions: 0, deletions: 0 });
    await store.importInbox('generation'); expect((await store.getRun(run.id))?.fileCount).toBe(1);
    const review = await service.review({ scope: 'turn', sessionId: 's', runId: run.id });
    expect(review.files[0].note).toContain('净变化为零'); expect(review.files[0].actions).toEqual([]);
    run.changes = {}; await store.writeRun(run, true);
    expect(await store.getRun(run.id, true)).toBeNull(); expect(await store.getRun(run.id)).toBeNull(); expect(await store.listRuns()).toEqual([]);
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
  it('marks binary, unavailable and ambiguous records unknown without counting cached or snippet statistics', async () => {
    const unknown = { ...snapshotOfText('hidden'), kind: 'unavailable' as const, text: null };
    const binary = snapshotFromBytes(Buffer.from([0, 1, 2]), 0);
    const run = recorded(1, { version: 2, boundary: 'user', endedAt: 2, changes: {
      'known.txt': { before: snapshotOfText('old\n'), after: snapshotOfText('new\nextra\n') },
      'binary.dat': { before: binary, after: { ...binary, hash: digest('other-binary') }, diffStats: { beforeHash: binary.hash, afterHash: digest('other-binary'), additions: 900, deletions: 800 } },
      'missing.txt': { before: snapshotOfText('old'), after: unknown },
      'ambiguous.txt': { before: snapshotOfText('old'), after: snapshotOfText('new'), ambiguous: true }
    } });
    await store.writeRun(run);
    const summary = await service.turnSummary({ runId: run.id, sessionId: 's', limit: 1 });
    expect(summary).toMatchObject({ fileCount: 4, additions: 2, deletions: 1, unknownFileCount: 3, incomplete: true });
    expect(summary.notice).toContain('行数未知'); expect(summary.files[0].statsKnown).toBe(true);
    const review = await service.review({ scope: 'turn', sessionId: 's', runId: run.id });
    for (const file of review.files.slice(1)) {
      expect(file).toMatchObject({ statsKnown: false, additions: 0, deletions: 0, actions: [] });
      const detail = await service.file({ reviewId: review.id, fileId: file.id });
      expect(detail.file.statsKnown).toBe(false); expect(detail.hunks).toEqual([]);
    }
    expect(review.run).toEqual((await service.bootstrap('s')).runs[0]);
  });
  it('invalidates persisted pre-contract card previews and detects corrupt text despite matching cached stats', async () => {
    const run = recorded(1, { version: 2, boundary: 'user', endedAt: 2, replyMessageId: 'reply' });
    await store.writeRun(run);
    const stored = (await store.getRun(run.id, false, false))!;
    stored.cardPreview = { key: digest(JSON.stringify([stored.contentVersion, stored.state, stored.incomplete, stored.changes])), summary: {
      runId: run.id, sessionId: 's', fileCount: 1, additions: 900, deletions: 800, incomplete: false, files: [], offset: 0, nextOffset: null
    } };
    await store.writeRun(stored);
    await fs.writeFile(path.join(store.directory, 'blobs', stored.changes['a.txt'].after.hash), 'wrong\n');
    const cards = await service.replyCards({ sessionId: 's' });
    expect(cards.cards[0].summary).toMatchObject({ additions: 0, deletions: 0, unknownFileCount: 1, incomplete: true });
    expect(cards.cards[0].summary.files[0].statsKnown).toBe(false);
    const persisted = (await store.getRun(run.id, false, false))!;
    expect(persisted.cardPreview?.key).not.toBe(stored.cardPreview.key);
    expect((await service.turnSummary({ runId: run.id, sessionId: 's' })).unknownFileCount).toBe(1);
    expect((await service.review({ scope: 'turn', runId: run.id, sessionId: 's' })).files[0].statsKnown).toBe(false);
  });
  it('exposes the exact same-session selected run even when bootstrap pagination cannot include it', async () => {
    const oldest = recorded(1); await store.writeRun(oldest);
    for (let i = 0; i < 100; i++) await store.writeRun(recorded(i + 2));
    await store.writeRun(recorded(1000, { sessionId: 'other' }));
    const boot = await service.bootstrap('s'); expect(boot.runs).toHaveLength(100); expect(boot.runs.some(run => run.id === oldest.id)).toBe(false);
    const review = await service.review({ scope: 'turn', sessionId: 's', runId: oldest.id });
    expect(review.run).toMatchObject({ id: oldest.id, sessionId: 's', root, fileCount: 1 });
    expect((await service.review({ scope: 'turn', sessionId: 'other', runId: oldest.id })).run).toBeUndefined();
  });
  it.each([false, true])('validates legacy inline history before counting it (corrupt: %s)', async corrupt => {
    const run = recorded(1);
    if (corrupt) run.changes['a.txt'].after.text = 'forged historical text';
    await atomicJson(path.join(store.directory, 'runs', `${run.id}.json`), run);
    const review = await service.review({ scope: 'turn', sessionId: 's', runId: run.id });
    expect(review.files[0]).toMatchObject({ statsKnown: !corrupt, additions: corrupt ? 0 : 1, deletions: corrupt ? 0 : 1, actions: [] });
    const summary = await service.turnSummary({ sessionId: 's', runId: run.id });
    expect(summary.unknownFileCount).toBe(corrupt ? 1 : 0);
    expect(await fs.readdir(path.join(store.directory, 'blobs'))).toEqual([]);
  });
});
