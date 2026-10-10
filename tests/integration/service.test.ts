import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os'; import { randomUUID } from 'node:crypto';
import { ReviewService } from '../../src/core/review-service'; import { SnapshotStore } from '../../src/core/storage'; import { snapshotOfText, readSnapshot, digest, canonical } from '../../src/core/path-policy'; import type { CaptureIdentity, CaptureRun, LineAnchor, ReviewSummary } from '../../src/core/contracts';
let root: string, store: SnapshotStore, service: ReviewService, run: CaptureRun;
function capture(value: string): CaptureIdentity { const absolutePath = path.resolve(root, value), identity = canonical(absolutePath); return { id: digest(identity).slice(0, 24), identity, absolutePath, path: value, origin: 'workspace' }; }
beforeEach(async () => {
 root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-service-')); store = new SnapshotStore(path.join(root, 'data')); await store.init();
 await fs.writeFile(path.join(root, 'a.txt'), 'after\n'); const after = await readSnapshot(root, 'a.txt');
 run = { version: 2, boundary: 'user', contentVersion: 1, id: randomUUID(), generation: 'test-generation-123456789', sessionId: 's', root, startedAt: Date.now()-5000, endedAt: Date.now(), state: 'completed', fileCount: 1, incomplete: false, changes: { 'a.txt': { capture: capture('a.txt'), before: snapshotOfText('before\n', after.mode), after } }, replies: [{ hash: digest('reply'), timestamp: Date.now() }], bindings: {} }; run.finalReply = run.replies[0]; await store.writeRun(run);
 service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({ locale: 'zh-CN', base: 'light' }), clipboard: async () => {}, openPanel: async () => {} }, run.generation);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function turn(): Promise<ReviewSummary> { return service.review({ scope: 'turn', runId: run.id, sessionId: 's' }); }
describe('review service', () => {
 it('returns missing history honestly and denies unapproved roots', async () => { expect((await service.review({ scope: 'turn', runId: randomUUID(), sessionId: 's' })).notice).toContain('No recorded'); await expect(service.review({ scope: 'unstaged', root: path.dirname(root) })).rejects.toThrow('authorized'); });
 it('comments validate original lines, preserve versions and become stale after diff version changes', async () => {
  const review = await turn(), file = review.files[0]; const anchor: LineAnchor = { root, path: file.path, scope: 'turn', runId: run.id, fingerprint: file.fingerprint, side: 'new', line: 1, text: 'after', excerpt: 'fake' };
  const comment = await service.saveComment({ anchor, body: 'Fix this', sessionId: 's' }); expect(comment.anchor.excerpt).toBe('after\n');
  expect((await service.feedback({ reviewId: review.id, sessionId: 's' })).text).toContain('Fix this');
  await expect(service.saveComment({ anchor: { ...anchor, text: 'not real' }, body: 'bad', sessionId: 's' })).rejects.toThrow('does not match');
  run.changes['a.txt'].after = snapshotOfText('different\n', run.changes['a.txt'].after.mode); await store.writeRun(run); const latest = await turn(); expect((await service.comments({ reviewId: latest.id }))[0].stale).toBe(true);
 });
 it('requires confirmation, restores/reapplies content and refuses conflict without writing', async () => {
  let review = await turn(), file = review.files[0]; await expect(service.action({ reviewId: review.id, fileId: file.id, action: 'revert', fingerprint: file.fingerprint, confirmed: false })).rejects.toThrow('confirmation');
  await service.action({ reviewId: review.id, fileId: file.id, action: 'revert', fingerprint: file.fingerprint, confirmed: true }); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('before\n');
  review = await turn(); file = review.files[0]; expect(file.actions).toEqual(['reapply']);
  await fs.writeFile(path.join(root, 'a.txt'), 'user'); await expect(service.action({ reviewId: review.id, fileId: file.id, action: 'reapply', fingerprint: file.fingerprint, confirmed: true })).rejects.toThrow('changed'); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('user');
  await fs.writeFile(path.join(root, 'a.txt'), 'before\n'); await service.action({ reviewId: review.id, fileId: file.id, action: 'reapply', fingerprint: file.fingerprint, confirmed: true }); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('after\n');
 });
 it('uniquely binds message replies and never guesses missing or ambiguous timestamps', async () => {
  const args = { sessionId: 's', messageId: 'msg', content: 'reply', createdAt: new Date(run.replies[0].timestamp).toISOString() }; expect((await service.card(args)).run?.id).toBe(run.id); expect((await service.card({ ...args, messageId: 'other' })).run).toBeNull();
  const duplicate = { ...run, id: randomUUID(), bindings: {} }; await store.writeRun(duplicate); expect((await service.card(args)).run).toBeNull(); expect((await service.card({ ...args, createdAt: undefined })).run).toBeNull();
 });
 it('paginates exact rows including large pages without gaps', async () => {
  run.changes['a.txt'].before = snapshotOfText(''); run.changes['a.txt'].after = snapshotOfText(Array.from({length:300},(_,i)=>`${i}:${'x'.repeat(400)}\n`).join('')); await store.writeRun(run); const review = await turn(); let offset = 0; const texts: string[] = [];
  do { const page = await service.file({ reviewId: review.id, fileId: review.files[0].id, offset, limit: 80 }); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48000); texts.push(...page.hunks.flatMap(h=>h.lines.filter(l=>l.kind==='add').map(l=>l.text))); if (page.nextOffset === null) break; offset = page.nextOffset; } while (offset < 1000);
  expect(texts).toHaveLength(300); expect(texts[299]).toContain('299:');
 });
 it('disables restores when a snapshot is missing or capture is incomplete', async () => { run.incomplete = true; await store.writeRun(run); expect((await turn()).files[0].actions).toEqual([]); run.incomplete = false; await store.writeRun(run); await fs.unlink(path.join(store.directory,'blobs',run.changes['a.txt'].before.hash)); expect((await turn()).files[0].actions).toEqual([]); });
 it('bounds comment transport and refuses clearing a live inbox capture', async () => {
  const review = await turn(), file = review.files[0]; const anchor: LineAnchor = { root, path: file.path, scope: 'turn', runId: run.id, fingerprint: file.fingerprint, side: 'new', line: 1, text: 'after', excerpt: '' };
  for (let i = 0; i < 20; i++) await service.saveComment({ anchor, body: '长'.repeat(4000), sessionId: 's' });
  expect(Buffer.byteLength(JSON.stringify(await service.comments({ reviewId: review.id })))).toBeLessThan(30000);
  run.state = 'running'; await store.writeRun(run, true);
  await expect(service.invoke('clearHistory', { confirmed: true })).rejects.toThrow('Stop active');
  expect(await store.getRun(run.id)).not.toBeNull();
 });
 it('rechecks capture completeness after a cached review before restoring', async () => {
  const review = await turn(), file = review.files[0]; run.incomplete = true; await store.writeRun(run, true);
  await expect(service.action({ reviewId: review.id, fileId: file.id, action: 'revert', fingerprint: file.fingerprint, confirmed: true })).rejects.toThrow('complete');
  expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('after\n');
 });
 it('reports each batch file independently and does not overwrite a conflicting file', async () => {
  await fs.writeFile(path.join(root, 'b.txt'), 'after-b\n'); const after = await readSnapshot(root, 'b.txt'); run.changes['b.txt'] = { capture: capture('b.txt'), before: snapshotOfText('before-b\n', after.mode), after }; run.fileCount = 2; await store.writeRun(run);
  const review = await turn(); await fs.writeFile(path.join(root, 'a.txt'), 'user changed');
  const args = { reviewId: review.id, action: 'revert' as const, confirmed: true, targets: review.files.map(f => ({ fileId: f.id, fingerprint: f.fingerprint })) };
  await expect(service.batchAction({ ...args, confirmed: false })).rejects.toThrow('confirmation');
  const result = await service.batchAction(args); expect(result.results.map(r => r.ok)).toEqual([false, true]);
  expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('user changed'); expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('before-b\n');
 });
 it('never supplements recorded context with current working-tree lines', async () => {
  run.changes['a.txt'].before = snapshotOfText('one\nbefore\nthree\n'); run.changes['a.txt'].after = snapshotOfText('one\nafter\nthree\n'); await store.writeRun(run);
  await fs.writeFile(path.join(root, 'a.txt'), 'fabricated live context'); const review = await turn();
  const detail = await service.file({ reviewId: review.id, fileId: review.files[0].id, context: -1 }); expect(detail.hunks.flatMap(h => h.lines).map(l => l.text).join('\n')).toContain('three');
  expect(JSON.stringify(detail)).not.toContain('fabricated');
 });
});
