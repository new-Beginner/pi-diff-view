import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun, ReviewSummary } from '../../src/core/contracts';
it('built main validates navigation, promotes a file beyond the first 100 and invalidates old sessions', async () => {
  const directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'review-nav-'));
  const data = path.join(directory, 'data'), root = path.join(directory, 'project'), entry = path.join(directory, 'main.cjs');
  await fs.mkdir(root); const store = new SnapshotStore(data); await store.init();
  const run: CaptureRun = { version: 1, id: 'test-nav-run', generation: 'old-generation', sessionId: 's', root, startedAt: Date.now(), endedAt: Date.now(), state: 'completed', incomplete: false, fileCount: 121, changes: {}, replies: [], bindings: {} };
  for (let i = 0; i < 121; i++) run.changes[`file-${i}.txt`] = { before: snapshotOfText('old\n'), after: snapshotOfText('new\n') };
  await store.writeRun(run);
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const home = vi.spyOn(os, 'homedir').mockReturnValue(directory), oldPi = (globalThis as any).pi;
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => ({ path: root }) }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); let loaded = false;
  try {
    await plugin.onLoad(); loaded = true;
    await plugin.onRendererCall('activeReviewSession', { sessionId: 's' });
    const summary = await plugin.onRendererCall('turnSummary', { sessionId: 's', runId: run.id, offset: 120, limit: 1 });
    const fileId = summary.files[0].id;
    const job = await plugin.onRendererCall('jobStart', { method: 'selectTurn', args: { sessionId: 's', runId: run.id, fileId } });
    let result: any;
    for (let i = 0; i < 100; i++) { result = await plugin.onRendererCall('jobPoll', job); if (result.state !== 'pending') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(result.state).toBe('done');
    const selection = await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: result.result.nonce });
    expect(selection.fileId).toBe(fileId);
    const review: ReviewSummary = await plugin.onPanelInvoke('diff.review', { ...selection.request, focusFileId: selection.fileId });
    expect(review.files).toHaveLength(100); expect(review.files[0].path).toBe('file-120.txt');
    const detail = await plugin.onPanelInvoke('diff.file', { reviewId: review.id, fileId }); expect(detail.file.path).toBe('file-120.txt');
    expect(detail.hunks[0].lines.some((line: any) => line.text === 'new')).toBe(true);
    await expect(plugin.onRendererCall('selectTurn', { sessionId: 's', runId: run.id, fileId: 'missing' })).rejects.toThrow('no longer');
    await expect(plugin.onRendererCall('selectTurn', { sessionId: 'other', runId: run.id })).rejects.toThrow('not found');
    await plugin.onRendererCall('activeReviewSession', { sessionId: 'other' });
    await expect(plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce })).rejects.toThrow('expired');
    await plugin.onRendererCall('activeReviewSession', { sessionId: 's' }); expect((await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce })).request.runId).toBe(run.id);
    await plugin.onUnload(); loaded = false; await expect(plugin.onRendererCall('readTurnSelection', { nonce: selection.nonce })).rejects.toThrow('not loaded');
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(directory, { recursive: true, force: true }); }
});
