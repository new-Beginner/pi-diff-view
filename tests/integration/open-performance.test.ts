import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

it('opens a 256-file task without reading unrelated history or hydrating unrelated text', async () => {
  const directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-open-performance-'));
  try {
    const root = path.join(directory, 'project'); await fs.mkdir(root);
    const store = new SnapshotStore(path.join(directory, 'data')); await store.init();
    const before = snapshotOfText('header\nold\n' + 'context\n'.repeat(1000));
    const after = snapshotOfText('header\nnew\n' + 'context\n'.repeat(1000));
    const run: CaptureRun = { version: 2, boundary: 'user', id: 'many-files', generation: 'generation', sessionId: 's', root, startedAt: 1, endedAt: 2, state: 'completed', fileCount: 256, incomplete: false, changes: {}, replies: [], bindings: {} };
    for (let i = 0; i < 256; i++) {
      const value = `file-${i}.txt`, absolutePath = path.join(root, value), identity = canonical(absolutePath);
      run.changes[value] = { before, after, capture: { path: value, absolutePath, identity, id: digest(identity).slice(0, 24), origin: 'workspace' } };
    }
    await store.writeRun(run);
    const clipboard = vi.fn(async (_text: string) => {});
    const service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard, openPanel: async () => {} }, 'generation');
    const hydrate = vi.spyOn(store, 'hydrate'), history = vi.spyOn(store, 'listRuns');
    const fileId = run.changes['file-255.txt'].capture!.id;
    const started = performance.now();
    await service.selectTarget({ runId: run.id, sessionId: 's', fileId });
    expect(hydrate).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
    const review = await service.review({ scope: 'turn', runId: run.id, sessionId: 's', root, focusFileId: fileId });
    const detail = await service.file({ reviewId: review.id, fileId });
    const cold = performance.now() - started;
    expect(history).not.toHaveBeenCalled(); expect(hydrate).toHaveBeenCalledTimes(2);
    expect(review.files[0].path).toBe('file-0.txt'); expect(detail.file.additions).toBe(1); expect(detail.file.deletions).toBe(1);
    const paths = review.files.map(file => file.path); let offset = review.nextFileOffset;
    while (offset != null) { const page = service.reviewFiles({ reviewId: review.id, offset }); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(34000); paths.push(...page.files.map(file => file.path)); offset = page.nextOffset; }
    expect(paths).toEqual(Array.from({ length: 256 }, (_, i) => `file-${i}.txt`));
    expect((await service.review({ scope: 'turn', runId: run.id, sessionId: 's', root, focusFileId: run.changes['file-1.txt'].capture!.id })).files.map(file => file.path)).toEqual(review.files.map(file => file.path));
    expect(detail.hunks[0].lines.some(line => line.text === 'new')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(34000);
    const warmStart = performance.now(); await service.file({ reviewId: review.id, fileId });
    console.log(`PERF task=256 files cold-select-review-first-page=${cold.toFixed(1)}ms cached-first-page=${(performance.now() - warmStart).toFixed(1)}ms hydrated=2`);
    await service.invoke('copyPatch', { reviewId: review.id, fileId: review.files[1].id });
    expect(clipboard.mock.calls[0][0]).toContain('+new'); expect(hydrate).toHaveBeenCalledTimes(6);
    const stored = await store.getRun(run.id, false, false);
    await fs.writeFile(path.join(store.directory, 'blobs', stored!.changes['file-0.txt'].after.hash), 'corrupt');
    const refreshed = await service.review({ scope: 'turn', runId: run.id, sessionId: 's', root, focusFileId: fileId });
    expect(refreshed.files[0].kind).toBe('unavailable'); expect(refreshed.files[0].actions).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 30000);
