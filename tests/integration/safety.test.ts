import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SnapshotStore } from '../../src/core/storage';
import { readSnapshot, snapshotOfText, absentSnapshot } from '../../src/core/path-policy';
import { replaceSnapshot } from '../../src/core/rollback';
import type { CaptureRun, ReviewComment } from '../../src/core/contracts';
let root: string, store: SnapshotStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-safety-')); store = new SnapshotStore(path.join(root, 'data')); await store.init(); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function run(): CaptureRun { return { version: 1, id: randomUUID(), sessionId: 's', generation: randomUUID(), root, startedAt: Date.now(), state: 'running', incomplete: false, fileCount: 1, changes: { 'a.txt': { before: absentSnapshot(), after: snapshotOfText('capture') } }, replies: [], bindings: {} }; }
it.each([true, false])('preserves an actual file changed after the final check (desired exists=%s)', async exists => {
  const target = path.join(root, 'a.txt'); await fs.writeFile(target, 'expected'); const expected = await readSnapshot(root, 'a.txt');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(from) === target && String(to).endsWith('.original')) await fs.writeFile(target, 'external last-moment save'); await rename(from, to); });
  await expect(replaceSnapshot(root, 'a.txt', expected, exists ? snapshotOfText('desired', expected.mode) : absentSnapshot(), path.join(store.directory, 'backups'))).rejects.toThrow('changed');
  expect(await fs.readFile(target, 'utf8')).toBe('external last-moment save');
});
it('does not overwrite a newly created target and keeps the actual original recovery file', async () => {
  const target = path.join(root, 'a.txt'); await fs.writeFile(target, 'original'); const expected = await readSnapshot(root, 'a.txt');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(from) === target && String(to).endsWith('.original')) await fs.writeFile(target, 'new external file'); });
  await expect(replaceSnapshot(root, 'a.txt', expected, snapshotOfText('desired', expected.mode), path.join(store.directory, 'backups'))).rejects.toThrow('Original preserved');
  expect(await fs.readFile(target, 'utf8')).toBe('new external file');
  const original = (await fs.readdir(root)).find(f => f.startsWith('.diff-view-') && f.endsWith('.original'))!;
  expect(await fs.readFile(path.join(root, original), 'utf8')).toBe('original');
});
it('a capture starting while clear holds the lock writes fresh blobs only after clear finishes', async () => {
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const save = store.saveComments.bind(store);
  vi.spyOn(store, 'saveComments').mockImplementation(async comments => { entered(); await gate; await save(comments); });
  const clearing = store.clear(); await inside;
  const other = new SnapshotStore(store.directory), captured = run(); const writing = other.writeRun(captured, true);
  await new Promise(r => setTimeout(r, 50)); expect(await other.getRun(captured.id, true)).toBeNull();
  release(); await clearing; await writing;
  expect((await other.getRun(captured.id, true))?.changes['a.txt'].after.text).toBe('capture');
  await expect(other.clear()).rejects.toThrow('Stop active');
});
it('refuses oversized comment storage without making previously readable comments unreadable', async () => {
  const comment: ReviewComment = { id: 'comment', body: 'valid', anchor: { root, path: 'a.txt', scope: 'unstaged', fingerprint: 'v', side: 'new', line: 1, text: '', excerpt: '' }, createdAt: 1, updatedAt: 1 };
  await store.saveComments([comment]);
  const huge = Array.from({ length: 600 }, (_, i) => ({ ...comment, id: `c${i}`, body: '长'.repeat(4000), anchor: { ...comment.anchor, text: '长'.repeat(4000), excerpt: '长'.repeat(4000) } }));
  await expect(store.saveComments(huge)).rejects.toThrow('byte limit'); expect(await store.comments()).toEqual([comment]);
});
it('rejects non-regular files before opening them', async () => { await fs.mkdir(path.join(root, 'directory')); await expect(readSnapshot(root, 'directory')).rejects.toThrow('regular'); });
it.skipIf(process.platform === 'win32')('does not block on FIFO files on POSIX', async () => { execFileSync('mkfifo', [path.join(root, 'pipe')]); await expect(readSnapshot(root, 'pipe')).rejects.toThrow('regular'); });
