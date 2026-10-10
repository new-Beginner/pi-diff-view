import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_TEXT_BYTES, type FileSnapshot, type GitScope, type InternalFile, type RepositoryInfo } from '../core/contracts';
import { absentSnapshot, assertPublicPath, canonical, digest, fail, safeResolve, sameSnapshot, snapshotFromBytes } from '../core/path-policy';
import { stats } from '../core/diff';
import { git, headCommit, OUTPUT_LIMIT, resolveCommit } from './runner';

export interface GitReview { root: string; scope: GitScope; files: InternalFile[]; notice?: string; ref?: string; }
interface Entry { mode: number; oid: string; stage: number; }
interface Change { path: string; oldPath?: string; status: InternalFile['status']; }
export interface ReviewState {
  root: string; scope: GitScope; indexPath: string; indexFingerprint: string; head?: string;
  files: Map<string, InternalFile>; working: Map<string, FileSnapshot>; objectLength: number;
}
const states = new WeakMap<GitReview, ReviewState>();
export function reviewState(review: GitReview): ReviewState {
  const state = states.get(review);
  if (!state) fail('INVALID_REVIEW', 'Refresh the Git review before acting');
  return state;
}

/** Never replace the authorized project with an enclosing repository. */
export async function discoverRepository(authorizedRoot: string): Promise<RepositoryInfo> {
  const root = await fs.realpath(authorizedRoot);
  if (!(await fs.stat(root)).isDirectory()) fail('INVALID_ROOT', 'Project root is not a directory');
  const result: RepositoryInfo = { root, name: path.basename(root), git: false };
  const top = await git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true, limit: 16384 });
  if (top.code !== 0) return result;
  const gitRoot = await fs.realpath(top.stdout.toString('utf8').replace(/\r?\n$/, ''));
  if (canonical(gitRoot) !== canonical(root)) return result;
  result.git = true;
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, limit: 4096 });
  if (branch.code === 0) result.branch = branch.stdout.toString('utf8').replace(/\r?\n$/, '');
  return result;
}

async function boundedRead(handle: fs.FileHandle, size: number, code: string): Promise<Buffer> {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > size) fail(code, 'File grew during bounded capture');
  return buffer.subarray(0, offset);
}

export async function readIndex(indexPath: string): Promise<{ bytes: Buffer | null; fingerprint: string }> {
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INDEX_DENIED', 'Git index must be a regular file');
    if (stat.size > OUTPUT_LIMIT) fail('GIT_LIMIT', 'Git index exceeds the size budget');
    handle = await fs.open(indexPath, 'r');
    const bytes = await boundedRead(handle, stat.size, 'STALE_INDEX');
    if (bytes.length > OUTPUT_LIMIT) fail('GIT_LIMIT', 'Git index exceeds the size budget');
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('STALE_INDEX', 'Index changed during capture');
    return { bytes, fingerprint: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, fingerprint: 'absent' };
    throw error;
  } finally { await handle?.close(); }
}

function bytesSnapshot(bytes: Buffer, mode: number): FileSnapshot {
  const snapshot = snapshotFromBytes(bytes, mode);
  // Preserve BOM bytes too: TextDecoder's default strips a UTF-8 BOM.
  if (snapshot.kind === 'text') snapshot.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return snapshot;
}
function metadata(kind: FileSnapshot['kind'], hash: string, mode: number, size = 0): FileSnapshot {
  return { exists: true, text: null, hash, size, mode, kind };
}

/** Leaf symlinks are metadata; symlink ancestors are refused, never followed. */
export async function workingSnapshot(root: string, rel: string, budget = MAX_TEXT_BYTES): Promise<FileSnapshot> {
  assertPublicPath(rel);
  const parent = path.posix.dirname(rel);
  if (parent !== '.') await safeResolve(root, parent);
  let target: string;
  try { target = await safeResolve(root, rel); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'SYMLINK_DENIED') throw error;
    const leaf = path.resolve(root, rel);
    const stat = await fs.lstat(leaf);
    if (!stat.isSymbolicLink()) throw error;
    return metadata('symlink', digest(await fs.readlink(leaf)), 0o120000, stat.size);
  }
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) return metadata('submodule', `directory:${stat.mtimeMs}`, 0o160000);
    if (!stat.isFile()) return metadata('unavailable', `special:${stat.mode}`, stat.mode);
    if (stat.size > MAX_TEXT_BYTES) return metadata('large', `large:${stat.size}:${stat.mtimeMs}`, stat.mode, stat.size);
    if (stat.size > budget) return metadata('unavailable', `budget:${stat.size}:${stat.mtimeMs}`, stat.mode, stat.size);
    handle = await fs.open(target, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs)
      fail('FILE_CHANGED', 'Working file changed during capture');
    const bytes = await boundedRead(handle, stat.size, 'FILE_CHANGED');
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('FILE_CHANGED', 'Working file changed during capture');
    await safeResolve(root, rel);
    return bytesSnapshot(bytes, stat.mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absentSnapshot();
    throw error;
  } finally { await handle?.close(); }
}

function records(bytes: Buffer): string[] {
  // Do not silently substitute U+FFFD and address a different filename.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).split('\0').filter(Boolean); }
  catch { fail('INVALID_PATH', 'Git filenames are not valid UTF-8; this repository is read-only'); }
}
function parseEntries(bytes: Buffer, tree: boolean): Map<string, Entry[]> {
  const result = new Map<string, Entry[]>();
  for (const row of records(bytes)) {
    const match = tree ? /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(row)
      : /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match) fail('GIT_FAILED', 'Invalid Git entry record');
    const rel = match[tree ? 3 : 4];
    const entry = { mode: parseInt(match[1], 8), oid: match[2], stage: tree ? 0 : Number(match[3]) };
    result.set(rel, [...(result.get(rel) ?? []), entry]);
  }
  return result;
}
async function treeEntries(root: string, commit?: string): Promise<Map<string, Entry[]>> {
  return commit ? parseEntries((await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit, '--'])).stdout, true) : new Map();
}
function changes(bytes: Buffer): Change[] {
  const rows = records(bytes), result: Change[] = [];
  for (let i = 0; i < rows.length;) {
    const code = rows[i++];
    if (!/^[ADMRTUC](?:\d+)?$/.test(code) || !rows[i]) fail('GIT_FAILED', 'Invalid Git change record');
    const first = rows[i++];
    if (code[0] === 'R' || code[0] === 'C') {
      const next = rows[i++];
      if (!next) fail('GIT_FAILED', 'Invalid Git rename record');
      result.push(code[0] === 'R' ? { path: next, oldPath: first, status: 'renamed' } : { path: next, status: 'added' });
    } else result.push({ path: first, status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified' });
  }
  return result;
}

export async function readGitReview(requestedRoot: string, scope: GitScope, ref?: string): Promise<GitReview> {
  if (!['unstaged', 'staged', 'commit', 'branch'].includes(scope)) fail('INVALID_SCOPE', 'Invalid Git review scope');
  const repo = await discoverRepository(requestedRoot);
  if (!repo.git) return { root: repo.root, scope, files: [], notice: 'Selected project is not a Git root; enclosing repositories are not authorized.' };
  const root = repo.root;
  const indexPath = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { limit: 16384 })).stdout.toString().replace(/\r?\n$/, '');
  const index = await readIndex(indexPath), head = await headCommit(root);
  const indexEntries = parseEntries((await git(root, ['ls-files', '--stage', '-z', '--'])).stdout, false);
  const objectLength = (await git(root, ['rev-parse', '--show-object-format'], { limit: 1024 })).stdout.toString().trim() === 'sha256' ? 64 : 40;
  const filemodeResult = await git(root, ['config', '--type=bool', '--get', 'core.filemode'], { allowFailure: true, limit: 1024 });
  const filemode = filemodeResult.stdout.toString().trim() !== 'false';
  const diffOptions = ['--name-status', '-z', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-l200', '--ignore-submodules=none'];
  let beforeEntries: Map<string, Entry[]>, afterEntries: Map<string, Entry[]>;
  let listed: Change[], notice: string | undefined, selectedRef: string | undefined;
  if (scope === 'unstaged') {
    beforeEntries = indexEntries; afterEntries = new Map();
    // Even a name-only working-tree diff can invoke configured clean/process filters.
    // Compare literal bytes ourselves instead; Git only supplies index/untracked names.
    listed = [...indexEntries.keys()].map(rel => ({ path: rel, status: 'modified' }));
    for (const rel of records((await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'])).stdout))
      listed.push({ path: rel, status: 'added' });
  } else if (scope === 'staged') {
    beforeEntries = await treeEntries(root, head); afterEntries = indexEntries;
    listed = changes((await git(root, ['diff', '--cached', ...diffOptions, ...(head ? [head] : []), '--'])).stdout);
    if (!head) notice = 'Unborn HEAD: staged changes are compared with an empty tree.';
  } else if (scope === 'commit') {
    selectedRef = await resolveCommit(root, ref ?? 'HEAD');
    // Read real commit headers: rev-list hides parents at shallow boundaries.
    const header = (await git(root, ['cat-file', 'commit', selectedRef])).stdout.toString('utf8').split('\n\n', 1)[0];
    const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (parents.some(parent => !new RegExp(`^[a-f0-9]{${objectLength}}$`).test(parent))) fail('GIT_FAILED', 'Invalid commit parent');
    beforeEntries = await treeEntries(root, parents[0]); afterEntries = await treeEntries(root, selectedRef);
    listed = changes((await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', ...diffOptions,
      ...(parents.length ? [parents[0], selectedRef] : [selectedRef]), '--'])).stdout);
    notice = parents.length > 1 ? 'Merge commit: compared with its first parent only.'
      : parents.length === 0 ? 'Root commit: compared with an empty tree.' : 'Commit: compared with its parent.';
  } else {
    if (!head) fail('NO_HEAD', 'Branch comparison requires a committed HEAD');
    if (!ref) fail('INVALID_REF', 'Branch comparison requires a local base reference');
    selectedRef = await resolveCommit(root, ref);
    const base = (await git(root, ['merge-base', '--all', selectedRef, head], { limit: 4096 })).stdout.toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) fail('INVALID_REF', 'No unique merge base');
    beforeEntries = await treeEntries(root, base); afterEntries = await treeEntries(root, head);
    listed = changes((await git(root, ['diff', ...diffOptions, base, head, '--'])).stdout);
    notice = `Branch: merge-base(${ref}, HEAD) ${base.slice(0, 12)} → HEAD ${head.slice(0, 12)}.`;
  }
  if (scope === 'unstaged' || scope === 'staged') for (const [rel, entries] of indexEntries)
    if (entries.some(entry => entry.stage !== 0)) listed.push({ path: rel, status: 'modified' });
  listed = [...new Map(listed.map(change => [change.path, change])).values()];
  if (listed.length > (scope === 'unstaged' ? 10000 : 1000)) fail('GIT_LIMIT', 'Repository path count exceeds the review budget');
  const review: GitReview = { root, scope, files: [], notice, ...(selectedRef ? { ref: selectedRef } : {}) };
  const state: ReviewState = { root, scope, indexPath, indexFingerprint: index.fingerprint, head,
    files: new Map(), working: new Map(), objectLength };
  let skipped = 0, remaining = OUTPUT_LIMIT;
  const deadline = Date.now() + 30000;
  const blob = async (entry?: Entry): Promise<FileSnapshot> => {
    if (!entry) return absentSnapshot();
    if (entry.mode === 0o120000) {
      const bytes = (await git(root, ['cat-file', 'blob', entry.oid], { limit: 8192 })).stdout;
      return metadata('symlink', digest(bytes), entry.mode, bytes.length);
    }
    if (entry.mode === 0o160000) return metadata('submodule', `git:${entry.oid}`, entry.mode);
    const size = Number((await git(root, ['cat-file', '-s', entry.oid], { limit: 1024 })).stdout.toString().trim());
    if (!Number.isSafeInteger(size) || size < 0) fail('GIT_FAILED', 'Invalid Git blob size');
    if (size > MAX_TEXT_BYTES) return metadata('large', `git:${entry.oid}`, entry.mode, size);
    if (size > remaining || Date.now() > deadline) return metadata('unavailable', `git:${entry.oid}`, entry.mode, size);
    remaining -= size;
    return bytesSnapshot((await git(root, ['cat-file', 'blob', entry.oid], { limit: MAX_TEXT_BYTES + 4096 })).stdout, entry.mode);
  };
  for (const change of listed) {
    if (Date.now() > deadline) fail('GIT_TIMEOUT', 'Review exceeded the time budget; use a smaller repository');
    let working: FileSnapshot, oldWorking: FileSnapshot | undefined;
    try {
      assertPublicPath(change.path);
      if (change.oldPath) assertPublicPath(change.oldPath);
      working = await workingSnapshot(root, change.path, remaining);
      if (working.kind === 'text' || working.kind === 'binary') remaining -= working.size;
      if (change.oldPath) {
        oldWorking = await workingSnapshot(root, change.oldPath, remaining);
        if (oldWorking.kind === 'text' || oldWorking.kind === 'binary') remaining -= oldWorking.size;
      }
    } catch (error) {
      if (['PATH_DENIED', 'INVALID_PATH', 'PATH_ESCAPE', 'SYMLINK_DENIED'].includes((error as { code: string }).code)) { skipped++; continue; }
      throw error;
    }
    const conflict = (scope === 'unstaged' || scope === 'staged') && indexEntries.get(change.path)?.some(entry => entry.stage !== 0);
    const leftEntry = beforeEntries.get(change.oldPath ?? change.path)?.find(entry => entry.stage === 0);
    const rightEntry = afterEntries.get(change.path)?.find(entry => entry.stage === 0);
    if (scope === 'unstaged' && !conflict) {
      if (leftEntry && working.kind === 'text' && working.text !== null) {
        const bytes = Buffer.from(working.text);
        const oid = createHash(objectLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const mode = filemode ? (working.mode & 0o111 ? 0o100755 : 0o100644) : leftEntry.mode === 0o100755 ? 0o100755 : 0o100644;
        if (oid === leftEntry.oid && mode === leftEntry.mode) { remaining += working.size; continue; }
      }
      change.status = !working.exists ? 'deleted' : !leftEntry ? 'added' : 'modified';
    }
    let before = conflict ? metadata('conflict', 'unmerged', 0) : await blob(leftEntry);
    let after = conflict ? metadata('conflict', 'unmerged', 0) : scope === 'unstaged' ? { ...working } : await blob(rightEntry);
    if (scope === 'unstaged' && after.exists && ['text', 'binary', 'large', 'unavailable'].includes(after.kind)) {
      after.mode = filemode ? (working.mode & 0o111 ? 0o100755 : 0o100644) : leftEntry?.mode === 0o100755 ? 0o100755 : 0o100644;
    }
    if (!conflict && !change.oldPath && before.kind === after.kind && sameSnapshot(before, after)) {
      if (before.kind === 'text' || before.kind === 'binary') remaining += before.size + working.size;
      continue;
    }
    if (before.kind === 'text' && after.kind === 'text' && before.exists && after.exists && before.hash === after.hash) {
      if ((before.mode & 0o777) === (after.mode & 0o777) && !change.oldPath) continue;
      if (!change.oldPath) change.status = 'mode';
    }
    let kind: InternalFile['kind'] = 'text';
    for (const candidate of ['conflict', 'symlink', 'submodule', 'large', 'binary', 'unavailable'] as const)
      if (before.kind === candidate || after.kind === candidate || working.kind === candidate) { kind = candidate; break; }
    let counts = { additions: 0, deletions: 0 }, note: string | undefined;
    if (kind === 'text') {
      try { counts = stats(before.text ?? '', after.text ?? ''); }
      catch (error) { if ((error as { code: string }).code !== 'DIFF_LIMIT') throw error; kind = 'unavailable'; note = 'Diff exceeds the computation budget.'; }
    }
    let actions: InternalFile['actions'] = [];
    if (kind !== 'text') {
      note ??= `${kind}: read-only metadata; no destructive actions.`;
      if (scope === 'unstaged' && (kind === 'large' || kind === 'submodule'))
        note = `${kind}: content/dirty status is not inspected; conservative read-only metadata.`;
    } else if (change.status === 'mode') note = 'Mode-only change: read-only metadata.';
    else if (change.status === 'renamed') {
      if (scope === 'staged' && working.kind === 'text' && oldWorking?.kind === 'text') actions = ['unstage'];
      note = 'Rename: only whole-file index unstage is supported; working rename/revert and hunks are read-only.';
    } else if (scope === 'unstaged') actions = ['stage', 'revert'];
    else if (scope === 'staged') actions = ['unstage'];
    const id = digest(`${root}\0${scope}\0${change.path}\0${change.oldPath ?? ''}`).slice(0, 32);
    const fingerprint = digest(JSON.stringify({ scope, change, before, after, index: index.fingerprint, working, oldWorking }));
    const file: InternalFile = { id, ...change, kind, ...counts, fingerprint, actions, before, after, indexFingerprint: index.fingerprint, ...(note ? { note } : {}) };
    if (review.files.length >= 1000) fail('GIT_LIMIT', 'More than 1000 changed files; use a smaller repository');
    review.files.push(file);
    state.files.set(id, structuredClone(file));
    state.working.set(change.path, working);
    if (change.oldPath && oldWorking) state.working.set(change.oldPath, oldWorking);
  }
  if (scope === 'unstaged') {
    // Only unambiguous exact-byte moves can be paired without filters or heuristic patches.
    const removed = review.files.filter(f => f.kind === 'text' && f.status === 'deleted');
    const added = review.files.filter(f => f.kind === 'text' && f.status === 'added');
    const discarded = new Set<string>();
    for (const previous of removed) {
      const matches = added.filter(f => f.after.hash === previous.before.hash);
      if (matches.length !== 1 || removed.filter(f => f.before.hash === previous.before.hash).length !== 1) continue;
      const next = matches[0];
      state.files.delete(previous.id); state.files.delete(next.id); discarded.add(previous.id);
      next.oldPath = previous.path; next.status = 'renamed'; next.before = previous.before;
      next.additions = 0; next.deletions = 0; next.actions = ['stage'];
      next.note = 'Exact-byte rename: whole-file stage only; working rename/revert and hunks are unsupported.';
      next.id = digest(`${root}\0${scope}\0${next.path}\0${next.oldPath}`).slice(0, 32);
      next.fingerprint = digest(JSON.stringify({ scope, path: next.path, oldPath: next.oldPath,
        before: next.before, after: next.after, index: index.fingerprint,
        working: state.working.get(next.path), oldWorking: state.working.get(next.oldPath) }));
      state.files.set(next.id, structuredClone(next));
    }
    review.files = review.files.filter(f => !discarded.has(f.id));
  }
  if ((await readIndex(indexPath)).fingerprint !== index.fingerprint) fail('STALE_INDEX', 'Index changed; refresh the review');
  for (const file of state.files.values()) if (file.actions.length) for (const rel of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
    if (!sameSnapshot(await workingSnapshot(root, rel), state.working.get(rel)!)) fail('FILE_CHANGED', 'Working file changed; refresh the review');
  }
  if (skipped) review.notice = [review.notice, `${skipped} credential/internal/unsafe path(s) omitted.`].filter(Boolean).join(' ');
  states.set(review, state);
  return review;
}
