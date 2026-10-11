import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReviewService } from '../../src/core/review-service';
import { SnapshotStore } from '../../src/core/storage';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';
let directory: string, store: SnapshotStore, service: ReviewService;
const host = { workspace: vi.fn(async () => { throw new Error('Card restoration must not scan Git/workspace'); }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({ locale: 'zh-CN', base: 'light' }), clipboard: async () => {}, openPanel: async () => {} };
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'reply-cards-'));
  store = new SnapshotStore(path.join(directory, 'data')); await store.init();
  service = new ReviewService(store, host, 'generation'); host.workspace.mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
async function seed(index = 0, count = 4): Promise<CaptureRun> {
  const timestamp = Date.now() - index * 4000, hash = digest(`done-${index}`), root = path.join(directory, 'workspace');
  const run: CaptureRun = { version: 2, boundary: 'user', contentVersion: 1, id: randomUUID(), generation: 'generation', sessionId: 'session', root, startedAt: timestamp - 1000, endedAt: timestamp + 10, state: 'completed', incomplete: false, fileCount: count, changes: {}, finalReply: { hash, timestamp }, replies: [{ hash, timestamp }], bindings: {} };
  for (let i = 0; i < count; i++) {
    const value = `file-${i}.txt`, absolutePath = path.join(root, value), identity = canonical(absolutePath);
    run.changes[value] = { capture: { id: digest(identity).slice(0, 24), identity, path: value, absolutePath, origin: 'workspace' }, before: snapshotOfText('old\n'), after: snapshotOfText('new\nextra\n') };
  }
  await store.writeRun(run); return run;
}
async function bind(run: CaptureRun, index = 0) { return service.card({ sessionId: run.sessionId, messageId: `message-${index}`, content: `Progress\n\ndone-${index}`, createdAt: new Date(run.finalReply!.timestamp).toISOString() }); }
it('persists exact card previews and restores after service restart without Git or diff recomputation', async () => {
  const run = await seed(), response = await bind(run);
  expect(response.summary).toMatchObject({ fileCount: 4, additions: 8, deletions: 4, nextOffset: 3 });
  expect(response.summary?.files).toHaveLength(3);
  const stored = await store.getRun(run.id, false, false);
  expect(stored?.cardPreview?.summary).toEqual(response.summary);
  const hydrate = vi.spyOn(store, 'hydrate');
  service = new ReviewService(store, host, 'new-generation');
  const page = await service.replyCards({ sessionId: 'session' });
  expect(page.cards).toHaveLength(1); expect(page.cards[0]).toMatchObject({ messageId: 'message-0', summary: JSON.parse(JSON.stringify(response.summary)) });
  expect(page.cards[0].summary.files.every(file => !file.actions.length)).toBe(true);
  expect(hydrate).not.toHaveBeenCalled(); expect(host.workspace).not.toHaveBeenCalled();
  expect(JSON.stringify(page)).not.toContain('Progress'); expect(JSON.stringify(page)).not.toContain('extra\\n');
  expect(await service.replyCards({ sessionId: 'session', revision: page.revision })).toMatchObject({ cards: [], unchanged: true });
});
it('restores bounded pages of older bindings and invalidates cached history when cleared', async () => {
  for (let i = 0; i < 25; i++) { const run = await seed(i, 1); run.bindings[run.finalReply!.hash] = `message-${i}`; await store.writeRun(run); }
  let offset = 0; const ids: string[] = [];
  do {
    const page = await service.replyCards({ sessionId: 'session', offset });
    expect(page.cards.length).toBeLessThanOrEqual(20); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(28 * 1024);
    ids.push(...page.cards.map(card => card.messageId));
    if (page.nextOffset === null) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
  } while (offset < 25);
  expect(new Set(ids).size).toBe(25); expect(host.workspace).not.toHaveBeenCalled();
  await store.clear(); expect((await service.replyCards({ sessionId: 'session' })).cards).toEqual([]);
});
it('rebuilds a preview when captured content changes and never restores another session', async () => {
  const run = await seed(); await bind(run);
  const first = await service.replyCards({ sessionId: 'session' });
  const stored = (await store.getRun(run.id, false, false))!;
  stored.changes['file-0.txt'].after = snapshotOfText('replacement\n'); stored.contentVersion!++;
  await store.writeRun(stored);
  const next = await service.replyCards({ sessionId: 'session', revision: first.revision });
  expect(next.revision).not.toBe(first.revision); expect(next.cards[0].summary.additions).toBe(7);
  expect((await service.replyCards({ sessionId: 'another' })).cards).toEqual([]);
});
it('omits ambiguous message bindings, uncertain boundaries, legacy, aborted and zero-change tasks', async () => {
  const a = await seed(0), b = await seed(1);
  for (const run of [a, b]) { run.bindings[run.finalReply!.hash] = 'duplicate-message'; await store.writeRun(run); }
  for (const [i, state] of ['uncertain', 'legacy', 'aborted', 'running', 'zero'].entries()) {
    const run = await seed(i + 2); run.bindings[run.finalReply!.hash] = `invalid-${i}`;
    if (state === 'uncertain') run.boundary = 'uncertain';
    if (state === 'legacy') { run.version = 1; for (const change of Object.values(run.changes)) delete change.capture; }
    if (state === 'aborted' || state === 'running') run.state = state;
    if (state === 'zero') for (const change of Object.values(run.changes)) change.after = change.before;
    await store.writeRun(run);
  }
  expect((await service.replyCards({ sessionId: 'session' })).cards).toEqual([]);
  await expect(service.replyCards({ sessionId: '' })).rejects.toThrow('sessionId');
});
