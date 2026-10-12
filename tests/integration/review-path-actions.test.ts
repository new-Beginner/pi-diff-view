import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReviewService } from '../../src/core/review-service';
import { SnapshotStore } from '../../src/core/storage';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun, ReviewSummary } from '../../src/core/contracts';

let directory: string, root: string, externalPath: string, store: SnapshotStore, service: ReviewService, review: ReviewSummary;
const clipboard = vi.fn(async (_text: string) => {});
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'review-path-actions-'));
  root = path.join(directory, 'workspace'); await fs.mkdir(root);
  // Public external-path metadata only; all fixture bytes stay in session scratch.
  externalPath = path.join(path.parse(directory).root, 'review-path-test-notes', `${randomUUID()}.md`);
  store = new SnapshotStore(path.join(directory, 'data')); await store.init();
  clipboard.mockClear();
  service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({ locale: 'zh-CN', base: 'light' }), clipboard, openPanel: async () => {} }, 'generation');
  const run: CaptureRun = { version: 2, boundary: 'user', contentVersion: 1, id: randomUUID(), generation: 'generation', sessionId: 'session', root, startedAt: Date.now() - 1000, endedAt: Date.now(), state: 'completed', incomplete: false, fileCount: 2, changes: {}, replies: [], bindings: {}, replyMessageId: 'reply' };
  for (const [value, origin] of [['src/example.ts', 'workspace'], [externalPath, 'external']] as const) {
    const absolutePath = origin === 'workspace' ? path.join(root, value) : value, identity = canonical(absolutePath);
    run.changes[value] = { capture: { id: digest(identity).slice(0, 24), identity, path: value, absolutePath, origin }, before: snapshotOfText('old\n'), after: snapshotOfText('new\n') };
  }
  await store.writeRun(run);
  review = await service.review({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root });
  expect(review.files).toHaveLength(2);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

it('copies the validated workspace path without loading historical content', async () => {
  const file = review.files.find(file => file.origin !== 'external')!;
  const hydrate = vi.spyOn(store, 'hydrate');
  await expect(service.invoke('copyPath', { reviewId: review.id, fileId: file.id })).resolves.toEqual({ ok: true });
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(path.join(root, 'src', 'example.ts'));
  expect(hydrate).not.toHaveBeenCalled();
});
it('copies the explicit external path, not a path under the review root', async () => {
  const file = review.files.find(file => file.origin === 'external')!;
  await service.invoke('copyPath', { reviewId: review.id, fileId: file.id });
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(externalPath);
});
it('rejects missing files and reviews without changing the clipboard', async () => {
  await expect(service.invoke('copyPath', { reviewId: review.id, fileId: 'missing' })).rejects.toThrow();
  await expect(service.invoke('copyPath', { reviewId: review.id })).rejects.toThrow();
  await expect(service.invoke('copyPath', { reviewId: 'missing', fileId: review.files[0].id })).rejects.toThrow();
  expect(clipboard).not.toHaveBeenCalled();
});
it('resolves an existing review file without reading content, and rejects missing files or another session', async () => {
  const file = review.files.find(file => file.origin !== 'external')!;
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/example.ts'), 'current\n');
  const hydrate = vi.spyOn(store, 'hydrate');
  await expect(service.fileOpenTarget({ reviewId: review.id, fileId: file.id, sessionId: 'session' })).resolves.toEqual({ sessionId: 'session', path: path.join(root, 'src/example.ts') });
  expect(hydrate).not.toHaveBeenCalled();
  await expect(service.fileOpenTarget({ reviewId: review.id, fileId: file.id, sessionId: 'other' })).rejects.toThrow();
  await expect(service.fileOpenTarget({ reviewId: review.id, fileId: 'missing', sessionId: 'session' })).rejects.toThrow();
  await fs.rm(path.join(root, 'src/example.ts'));
  await expect(service.fileOpenTarget({ reviewId: review.id, fileId: file.id, sessionId: 'session' })).rejects.toThrow();
});
