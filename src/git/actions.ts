import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Action, FileSnapshot, InternalFile } from '../core/contracts';
import { absentSnapshot, assertPublicPath, fail, safeResolve, sameSnapshot, snapshotOfText } from '../core/path-policy';
import { buildHunks, selectHunkText } from '../core/diff';
import { replaceSnapshot } from '../core/rollback';
import { readIndex, reviewState, workingSnapshot, type GitReview, type ReviewState } from './repository';
import { git, headCommit } from './runner';

/** Reverse the ORIGINAL selected coordinates, not a newly numbered inverse diff. */
function reverseHunkText(before: string, after: string, hunkId: string): string {
  const hunk = buildHunks(before, after).find(h => h.id === hunkId);
  if (!hunk) fail('STALE_HUNK', 'Hunk changed; refresh the review');
  const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const oldStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
  const newStart = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  const desired = [...right.slice(0, newStart), ...left.slice(oldStart, oldStart + hunk.oldLines),
    ...right.slice(newStart + hunk.newLines)].join('');
  // selectHunkText always applies baseline -> target; here the baseline is the current side.
  const inverse = buildHunks(after, desired);
  if (inverse.length !== 1) fail('STALE_HUNK', 'Cannot isolate the exact reverse edit safely');
  const selected = selectHunkText(after, desired, inverse[0].id);
  if (selected !== desired) fail('STALE_HUNK', 'Cannot isolate the exact reverse edit safely');
  return selected;
}
function desiredSnapshot(file: InternalFile, action: Action, hunkId?: string): FileSnapshot {
  if (!hunkId) return structuredClone(action === 'stage' ? file.after : file.before);
  const before = file.before.text ?? '', after = file.after.text ?? '';
  const text = action === 'stage' ? selectHunkText(before, after, hunkId) : reverseHunkText(before, after, hunkId);
  const target = action === 'stage' ? file.after : file.before;
  if (!target.exists && text === '') return absentSnapshot();
  const mode = action === 'stage' ? (file.before.exists ? file.before.mode : file.after.mode) : file.after.mode || file.before.mode;
  return snapshotOfText(text, mode);
}
async function guard(state: ReviewState, file: InternalFile, action: Action): Promise<void> {
  if ((await readIndex(state.indexPath)).fingerprint !== state.indexFingerprint || file.indexFingerprint !== state.indexFingerprint)
    fail('STALE_INDEX', 'Index changed; refresh the review');
  if (action === 'unstage' && await headCommit(state.root) !== state.head)
    fail('STALE_HEAD', 'HEAD changed; refresh the review');
  for (const rel of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
    assertPublicPath(rel);
    await safeResolve(state.root, rel);
    const expected = state.working.get(rel);
    if (!expected || !sameSnapshot(expected, await workingSnapshot(state.root, rel)))
      fail('FILE_CHANGED', 'Working file changed; refresh the review');
  }
}

export async function applyGitAction(review: GitReview, fileId: string, action: Action, fingerprint: string,
  hunkId?: string, backupDir?: string): Promise<void> {
  const state = reviewState(review), file = state.files.get(fileId);
  if (!file || file.fingerprint !== fingerprint) fail('STALE_FILE', 'File changed; refresh the review');
  if (!file.actions.includes(action) || file.kind !== 'text') fail('ACTION_DENIED', 'This change is read-only for the requested action');
  if (file.oldPath && hunkId) fail('ACTION_DENIED', 'Rename actions require the whole file');
  if (action === 'revert' && !backupDir) fail('BACKUP_REQUIRED', 'A recovery backup directory is required');
  const desired = desiredSnapshot(file, action, hunkId);
  // Cooperative Git writers cannot change the real index while we validate/build/install.
  const lockPath = `${state.indexPath}.lock`;
  let lock: fs.FileHandle;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('INDEX_LOCKED', 'Git index is locked; retry after the other operation finishes');
    throw error;
  }
  let tempDir: string | undefined, installed = false;
  try {
    await guard(state, file, action);
    if (action === 'revert') {
      await guard(state, file, action);
      await replaceSnapshot(state.root, file.path, state.working.get(file.path)!, desired, backupDir!);
      return;
    }
    tempDir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'pi-git-index-'));
    const tempIndex = path.join(tempDir, 'index');
    const current = await readIndex(state.indexPath);
    if (current.fingerprint !== state.indexFingerprint) fail('STALE_INDEX', 'Index changed; refresh the review');
    if (current.bytes) await fs.writeFile(tempIndex, current.bytes, { flag: 'wx', mode: 0o600 });
    else await git(state.root, ['read-tree', '--empty'], { index: tempIndex, limit: 4096 });
    await git(state.root, ['update-index', '--no-split-index'], { index: tempIndex, limit: 4096 });
    const changes: { path: string; snapshot: FileSnapshot }[] = file.oldPath
      ? action === 'stage'
        ? [{ path: file.oldPath, snapshot: absentSnapshot() }, { path: file.path, snapshot: desired }]
        : [{ path: file.path, snapshot: absentSnapshot() }, { path: file.oldPath, snapshot: file.before }]
      : [{ path: file.path, snapshot: desired }];
    const rows: string[] = [];
    for (const change of changes) {
      assertPublicPath(change.path);
      await safeResolve(state.root, change.path);
      if (!change.snapshot.exists) rows.push(`0 ${'0'.repeat(state.objectLength)}\t${change.path}\0`);
      else {
        if (change.snapshot.kind !== 'text' || change.snapshot.text === null) fail('ACTION_DENIED', 'Only exact UTF-8 text index content can be changed');
        const oid = (await git(state.root, ['hash-object', '--no-filters', '-w', '--stdin'], {
          input: Buffer.from(change.snapshot.text, 'utf8'), limit: 4096,
        })).stdout.toString().trim();
        if (!new RegExp(`^[a-f0-9]{${state.objectLength}}$`).test(oid)) fail('GIT_FAILED', 'Invalid new blob object');
        rows.push(`${(change.snapshot.mode & 0o111 ? 0o100755 : 0o100644).toString(8)} ${oid}\t${change.path}\0`);
      }
    }
    await git(state.root, ['update-index', '-z', '--index-info'], { index: tempIndex, input: Buffer.from(rows.join('')), limit: 4096 });
    const replacement = await readIndex(tempIndex);
    if (!replacement.bytes) fail('GIT_FAILED', 'Temporary index was not created');
    await lock.writeFile(replacement.bytes);
    await lock.sync();
    await guard(state, file, action);
    await lock.close();
    await fs.rename(lockPath, state.indexPath);
    installed = true;
  } finally {
    await lock.close().catch(() => {});
    if (!installed) await fs.unlink(lockPath).catch(() => {});
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}
