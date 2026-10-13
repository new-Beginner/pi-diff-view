import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SnapshotStore } from '../../src/core/storage';
import { snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun, ReviewSummary } from '../../src/core/contracts';
it('built main validates session-scoped navigation and restores selection after reload', async () => {
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
    const selection = await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: result.result.nonce, sessionId: 's' });
    expect(selection.fileId).toBe(fileId);
    const review: ReviewSummary = await plugin.onPanelInvoke('diff.review', { ...selection.request, focusFileId: selection.fileId });
    expect(review.files.length).toBeGreaterThan(0); expect(review.files.length).toBeLessThanOrEqual(100); expect(review.files[0].path).toBe('file-0.txt');
    const continuation = await plugin.onPanelInvoke('diff.reviewFiles', { reviewId: review.id, offset: review.nextFileOffset });
    expect(continuation.files.at(-1).path).toBe('file-120.txt'); expect(continuation.nextOffset).toBeNull();
    const detail = await plugin.onPanelInvoke('diff.file', { reviewId: review.id, fileId }); expect(detail.file.path).toBe('file-120.txt');
    expect(detail.hunks[0].lines.some((line: any) => line.text === 'new')).toBe(true);
    await fs.writeFile(path.join(root, 'file-120.txt'), 'current\n');
    const listener = plugin.onRendererCall('openFile', { listen: true, sessionId: 's', listenerId: 'navigation-listener' });
    const originalWorkspace = (globalThis as any).pi.workspace.get;
    let releaseHistory!: () => void;
    (globalThis as any).pi.workspace.get = () => new Promise(resolve => { releaseHistory = () => resolve({ path: root }); });
    const blockedHistory = plugin.onPanelInvoke('diff.bootstrap', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      // Selection must not queue behind bootstrap or mutate its authorization.
      const quick = await plugin.onRendererCall('jobStart', { method: 'selectTurn', args: { sessionId: 's', runId: run.id, fileId }, waitMs: 40 });
      let quickResult = quick;
      for (let i = 0; quickResult.state !== 'done' && i < 50; i++) { quickResult = await plugin.onRendererCall('jobPoll', quick); if (quickResult.state === 'error') break; await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(quickResult.state).toBe('done');
      expect((await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: quickResult.result.nonce, sessionId: 's' })).fileId).toBe(fileId);
      const clickedAt = performance.now();
      const open = await plugin.onPanelInvoke('diff.openFile', { reviewId: review.id, fileId, sessionId: 's' });
      expect(await listener).toEqual([{ ...open, sessionId: 's', path: path.join(root, 'file-120.txt') }]);
      const acknowledgement = plugin.onPanelInvoke('diff.openFile', { ...open, wait: true });
      await plugin.onRendererCall('openFile', { ...open, sessionId: 's', complete: true });
      expect((await acknowledgement).state).toBe('done');
      expect(performance.now() - clickedAt).toBeLessThan(1000);
    } finally { (globalThis as any).pi.workspace.get = originalWorkspace; releaseHistory(); await blockedHistory; }
    expect((await plugin.onRendererCall('replyCards', { sessionId: 's' })).fileOpens).toBeUndefined();
    await expect(plugin.onPanelInvoke('diff.openFile', { reviewId: review.id, fileId, sessionId: 'other' })).rejects.toThrow();
    await expect(plugin.onRendererCall('selectTurn', { sessionId: 's', runId: run.id, fileId: 'missing' })).rejects.toThrow('no longer');
    await expect(plugin.onRendererCall('selectTurn', { sessionId: 'other', runId: run.id })).rejects.toThrow('not found');
    await plugin.onRendererCall('activeReviewSession', { sessionId: 'other' });
    await expect(plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce })).rejects.toThrow('会话标识');
    await expect(plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce, sessionId: 'other' })).rejects.toThrow('不存在');
    expect((await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce, sessionId: 's' })).request.runId).toBe(run.id);
    await plugin.onUnload(); loaded = false;
    await expect(plugin.onRendererCall('readTurnSelection', { nonce: selection.nonce })).rejects.toThrow('not loaded');
    await plugin.onLoad(); loaded = true;
    expect((await plugin.onPanelInvoke('diff.readTurnSelection', { nonce: selection.nonce, sessionId: 's' })).fileId).toBe(fileId);
    expect((await plugin.onRendererCall('bootstrap', {})).runs).toEqual([]);
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(directory, { recursive: true, force: true }); }
});
