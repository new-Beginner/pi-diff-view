import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import { SnapshotStore } from '../../src/core/storage';
import { capturedChange, expirePublicCache, publicDesktopFixture, seedCapture, unavailableText, type PublicSessionFixture } from '../helpers/public-desktop-fixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(flushed: boolean, missingBefore = false, reply = true, status: 'missing' | 'denied' = 'denied') {
  const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'cold-review-'));
  const root = path.join(temp, 'project'), host = path.join(temp, 'host'), data = path.join(host, 'plugins', 'data', 'local.diff-view');
  const sessionId = 'cold-session', userId = 'cold-user', callId = 'cold-edit', now = Date.now() - 10000;
  await fs.mkdir(root);
  const messages = [
    { id: userId, role: 'user', createdAt: now, blocks: [], meta: { status: 'complete' } },
    { id: callId, role: 'tool', createdAt: now + 1000, blocks: [{ type: 'tool_call', callId, name: 'Edit', args: { path: 'a.txt', old_string: 'old', new_string: 'new' }, status: 'success', result: { isError: false, details: { review: { version: 1, messageId: callId, path: 'a.txt', beforeExists: true, beforeHash: digest('old\n'), afterExists: true, afterHash: digest('new\n'), hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }] } } } }], meta: { status: 'complete' } },
    { id: 'cold-reply', role: 'assistant', createdAt: now + 2000, blocks: [{ type: 'text', text: 'done' }], meta: { status: 'complete' } }
  ];
  const completeMessages = messages.filter(m => reply || m.role !== 'assistant');
  const session: PublicSessionFixture = { messages: flushed ? completeMessages : messages.slice(0, 1), projectPath: flushed ? root : undefined, ...(reply ? {} : { status }) };
  const desktop = publicDesktopFixture({ [sessionId]: session });
  const store = new SnapshotStore(data); await store.init();
  const capture = () => seedCapture(store, { id: 'saved-capture', sessionId, root, userMessageId: userId, startedAt: now, changes: { 'a.txt': capturedChange(root, 'a.txt', missingBefore ? unavailableText('old\n') : snapshotOfText('old\n'), unavailableText('new\n'), [`edit:${callId}`]) } });
  if (flushed) await capture();
  // Current disk bytes must never be used as a substitute for recorded endpoints.
  await fs.writeFile(path.join(root, 'a.txt'), 'unrelated later disk content\n');
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const previous = (globalThis as any).pi;
  vi.spyOn(os, 'homedir').mockReturnValue(temp);
  (globalThis as any).pi = { desktop, plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => ({ path: root }) }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry);
  await plugin.onLoad();
  cleanups.push(async () => { await plugin.onUnload(); (globalThis as any).pi = previous; await fs.rm(temp, { recursive: true, force: true }); });
  const review = (extra = {}) => plugin.onRendererCall('review', { scope: 'lastTurn', sessionId, ...extra });
  const publishEvidence = async () => {
    session.messages = completeMessages; session.projectPath = root;
    await capture(); await expirePublicCache();
    return plugin.onRendererCall('sessionContext', { sessionId });
  };
  return { plugin, review, publishEvidence, root, sessionId, store, userId, session, desktop };
}
it('prepares authorized saved history on the first review without renderer context', async () => {
  const f = await fixture(true);
  const first = await f.review();
  expect(first.files).toHaveLength(1);
  expect(first.files[0]).toMatchObject({ path: 'a.txt', statsKnown: true, additions: 1, deletions: 1 });
  expect(first.sync?.state).toBe('ready'); expect(first.run.state).toBe('completed');
  expect(f.desktop.invoke.mock.calls.map(([input]) => input.operation)).toEqual(expect.arrayContaining(['agent/getStatus', 'session/get']));
  const detail = await f.plugin.onRendererCall('file', { reviewId: first.id, fileId: first.files[0].id });
  expect(detail.hunks.flatMap((h: any) => h.lines).map((l: any) => l.text).join('\n')).not.toContain('unrelated later');
  expect((await f.review()).id).toBe(first.id);
  await expect(f.review({ root: path.dirname(f.root) })).rejects.toThrow(/authorized|授权/);
  const other = await f.plugin.onRendererCall('review', { scope: 'lastTurn', sessionId: 'other-session', root: f.root });
  expect(other.files).toEqual([]);
});
it('returns pending without blocking queued public context, then recovers a pinned completed turn', async () => {
  const f = await fixture(false);
  const first = await f.review();
  expect(first.sync?.state).toBe('pending');
  expect(first.files).toEqual([]);
  // Real JobQueue path: a review must finish instead of waiting for work behind it.
  const started = await f.plugin.onRendererCall('jobStart', { method: 'review', args: { scope: 'lastTurn', sessionId: f.sessionId }, waitMs: 40 });
  await f.publishEvidence();
  await expect.poll(async () => (await f.plugin.onRendererCall('jobPoll', { jobId: started.jobId })).state).toBe('done');
  const recovered = await f.review();
  expect(recovered.sync?.state).toBe('ready');
  expect(recovered.files[0]).toMatchObject({ statsKnown: true, additions: 1, deletions: 1 });
  const pinned = await f.plugin.onRendererCall('review', { scope: 'turn', sessionId: f.sessionId, runId: recovered.runId });
  expect(pinned.sync?.state).toBe('ready'); expect(pinned.run.state).toBe('completed');
});
it('keeps genuine missing endpoints unknown once context is prepared', async () => {
  const f = await fixture(true, true);
  // Transcript preparation can be ready while both historical endpoints remain unknown.
  const first = await f.review();
  expect(first.files[0]).toMatchObject({ statsKnown: false, kind: 'unavailable', additions: 0, deletions: 0 });
  await f.plugin.onRendererCall('sessionContext', { sessionId: f.sessionId });
  const result = await f.review();
  expect(result.sync?.state).toBe('ready');
  expect(result.files[0]).toMatchObject({ statsKnown: false, kind: 'unavailable', additions: 0, deletions: 0 });
});
it('bounds waiting and exposes saved evidence with an explicit unavailable state', async () => {
  const f = await fixture(false);
  expect((await f.review()).sync?.state).toBe('pending');
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16000);
  const result = await f.review(); clock.mockRestore();
  expect(result.sync?.state).toBe('unavailable');
  expect(result.files).toEqual([]);
  // A manual retry opens a new bounded preparation window, not an endless spinner.
  expect((await f.review({ retrySync: true })).sync?.state).toBe('pending');
});
it.each(['missing', 'denied'] as const)('keeps %s native status unknown despite forged renderer completion', async status => {
  const f = await fixture(true, false, false, status);
  const read = fs.readFile.bind(fs);
  const reads = vi.spyOn(fs, 'readFile').mockImplementation(((value: any, ...args: any[]) => {
    if (/[/\\](sessions|review-changes)[/\\]/.test(String(value))) throw new Error('No private host history fallback');
    return (read as any)(value, ...args);
  }) as any);
  await f.plugin.onRendererCall('sessionContext', { sessionId: f.sessionId, running: false, taskId: 'forged-user', since: Date.now() });
  const result = await f.review();
  expect(result.sync?.state).toBe('ready');
  expect(result.run.state).toBe('unknown');
  expect(result.files[0]).toMatchObject({ statsKnown: true, additions: 1, deletions: 1, actions: [] });
  expect(reads.mock.calls.some(([value]) => /[/\\](sessions|review-changes)[/\\]/.test(String(value)))).toBe(false);
});
it('repairs an early ambiguous inbox record before exposing its first review', async () => {
  const f = await fixture(true);
  const unavailable = (hash: string) => ({ exists: true, hash, text: null, size: 4, mode: 0, kind: 'unavailable' as const });
  const absolutePath = path.join(f.root, 'a.txt'), identity = canonical(absolutePath);
  const capture = { id: digest(identity).slice(0, 24), identity, path: 'a.txt', origin: 'workspace' as const, absolutePath };
  await f.store.writeRun({ version: 2, id: 'early-capture', generation: 'old', sessionId: f.sessionId, root: f.root, boundary: 'user', userMessageId: f.userId, startedAt: Date.now() - 10000, state: 'unknown', fileCount: 1, incomplete: true, changes: { 'a.txt': { capture, before: unavailable(digest('old\n')), after: unavailable(digest('new\n')), ambiguous: true, evidence: ['edit:cold-edit'] } }, replies: [], bindings: {} }, true);
  expect(await f.store.getRun('early-capture', true, false)).not.toBeNull();
  const first = await f.review();
  expect(first.sync?.state).toBe('ready'); expect((await f.store.getRun('early-capture'))?.id).toBe(first.runId);
  expect(first.files[0]).toMatchObject({ statsKnown: true, kind: 'text', additions: 1, deletions: 1 });
});
