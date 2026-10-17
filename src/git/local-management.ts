import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { assertPublicPath, canonical, digest, fail, readSnapshot, safeResolve } from '../core/path-policy';
import { discoverRepository } from './repository';
import { git, headCommit, resolveCommit } from './runner';
import { ReadWriteQueue } from '../core/read-write-queue';

/** Independent human-UI API; never uses session records. See dispatch() for the operation vocabulary.
 * Reference: official PI-Desktop pi.gitlens 0.2.7 (main.js/git.js/renderer/panel.js),
 * not the third-party IDEA Git plugin. This implementation does not copy its source.
 */
export interface ManagementEntry { path: string; index: string; working: string; blocked?: string; stats?: ManagementStat; }
export interface ManagementRepository { root: string; branch: string | null; head: string | null; }
export interface ManagementStatus extends ManagementRepository { entries: ManagementEntry[]; }
export interface ManagementBranch { name: string; oid: string; current: boolean; worktreePath?: string; }
export interface ManagementCommit { oid: string; author: string; date: string; subject: string; }
export interface ManagementStash { ref: string; oid: string; subject: string; }
export interface ManagementText { text: string; truncated: boolean; notice?: string; }
export interface ManagementStat { path: string; additions: number | null; deletions: number | null; kind?: 'binary' | 'large' | 'unknown'; }
export interface ManagementCommitFile extends ManagementStat { status: string; blocked?: string; }
export interface ManagementCommitFiles { oid: string; parent: string | null; entries: ManagementCommitFile[]; }
export interface ManagementBranchResult { ok: true; repository?: ManagementRepository; notice?: string; }
export interface ManagementArgs {
  operation: string; root?: string; paths?: string[]; path?: string; scope?: 'workspace' | 'staged';
  message?: string; summary?: string; description?: string; name?: string; newName?: string; ref?: string; oid?: string;
  confirmed?: boolean; includeUntracked?: boolean; skip?: number; limit?: number;
  fingerprint?: string; includeRepository?: boolean; summaryOnly?: boolean; includeStats?: boolean;
  expectedHead?: string | null; expectedBranch?: string | null;
}
const mutations = new Set(['stage', 'unstage', 'discard', 'commit', 'branchCreate', 'branchSwitch', 'branchRename', 'branchDelete', 'stashCreate', 'stashApply', 'stashPop', 'stashDrop']);
const confirmation = new Set(['discard', 'commit', 'branchSwitch', 'branchRename', 'branchDelete', 'stashCreate', 'stashApply', 'stashPop', 'stashDrop']);
const operations = new Set(['status', 'diff', 'stats', 'discardPreview', 'branches', 'history', 'commitFiles', 'commitDiff', 'blame', 'stashList', 'stashShow', ...mutations]);
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
const queues = new Map<string, ReadWriteQueue>();
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', `${label} is required (maximum ${max} characters).`);
  return value;
}
function records(value: Buffer): string[] {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value).split('\0').filter(Boolean); }
  catch { fail('INVALID_PATH', 'Git filenames must be valid UTF-8. Use the Git CLI for this repository.'); }
}
function output(value: string, notice?: string): ManagementText {
  // Leave room for JSON escaping and bridge framing (62 KiB total).
  let end = Math.min(value.length, 24000);
  while (Buffer.byteLength(JSON.stringify(value.slice(0, end))) > 46000) end = Math.floor(end * 0.8);
  return { text: value.slice(0, end), truncated: end < value.length, ...(notice ? { notice } : {}) };
}

/** Local management deliberately respects user identity/global config and commit hooks.
 * No shell, inherited Git overrides, pager/editor prompts, external diff or network protocols.
 * Other operations disable hooks; commit does NOT pass core.hooksPath or --no-verify.
 * Repository filters and commit hooks remain trusted local code, like native Git.
 */
async function run(root: string, args: string[], hooks = false, index?: string): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C' });
  if (index) env.GIT_INDEX_FILE = index;
  // stash internally generates magic pathspecs for cleaning saved untracked files.
  // No stash operation accepts a caller-supplied pathspec; keeping literal mode breaks its cleanup.
  if (args[0] === 'stash') delete env.GIT_LITERAL_PATHSPECS;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
      '-c', 'diff.external=', ...(hooks ? [] : ['-c', 'core.hooksPath=/dev/null']), ...args],
    { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let size = 0; let failure: Error | undefined;
    const abort = (code: string, message: string) => { failure ??= Object.assign(new Error(message), { code }); child.kill(); };
    const timer = setTimeout(() => abort('GIT_TIMEOUT', 'Git timed out. Refresh and inspect the repository before retrying; a hook may have changed it.'), hooks ? 90000 : 30000);
    const collect = (parts: Buffer[], bytes: Buffer) => { size += bytes.length; if (size > 8 * 1024 * 1024) abort('GIT_LIMIT', 'Git output is too large. Narrow the selection.'); else parts.push(bytes); };
    child.stdout.on('data', bytes => collect(out, bytes)); child.stderr.on('data', bytes => collect(err, bytes));
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(Object.assign(new Error(`${Buffer.concat(err).toString().trim() || Buffer.concat(out).toString().trim() || 'Git failed'}`.slice(0, 5000)), { code: 'GIT_FAILED' })); return; }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}
async function filePath(root: string, value: unknown): Promise<string> {
  const rel = text(value, 'Repository-relative file path');
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.includes('\\') || rel.split('/').some(p => p === '.' || p === '..' || p === '')) fail('INVALID_PATH', 'Select an explicit repository-relative file, not a directory or traversal path.');
  assertPublicPath(rel);
  const resolved = await safeResolve(root, rel);
  const stat = await fs.lstat(resolved).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && !stat.isFile()) fail('NOT_FILE', 'Only regular files are supported; directories and submodules are not selectable.');
  return rel;
}
async function selected(root: string, values: unknown): Promise<string[]> {
  if (!Array.isArray(values) || !values.length || values.length > 500) fail('INVALID_PATH', 'Select between 1 and 500 explicit file paths.');
  return [...new Set(await Promise.all(values.map(value => filePath(root, value))))];
}
async function currentBranch(root: string): Promise<string | null> {
  const branch = await git(root, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  if (branch.code === 1) return null;
  if (branch.code !== 0) fail('GIT_FAILED', 'Could not read the current branch.');
  const ref = branch.stdout.toString().trim();
  if (!ref.startsWith('refs/heads/')) fail('INVALID_REF', 'HEAD does not point to a local branch.');
  return ref.slice('refs/heads/'.length);
}
/** Header-only information: list pages must not scan or validate working files. */
async function repositorySummary(root: string): Promise<ManagementRepository> {
  const [head, branch] = await Promise.allSettled([headCommit(root), currentBranch(root)]);
  if (head.status === 'rejected') throw head.reason;
  if (branch.status === 'rejected') throw branch.reason;
  return { root, branch: branch.value, head: head.value ?? null };
}
async function status(root: string, includeStats = false): Promise<ManagementStatus> {
  const [raw, head, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']), headCommit(root),
    currentBranch(root),
  ]);
  const rows = records(raw.stdout);
  if (rows.length > 500) fail('GIT_LIMIT', 'More than 500 changed files. Use the Git CLI or narrow this repository.');
  const entries: ManagementEntry[] = [];
  // Only a small first-page budget is read inline; bulk/large files remain asynchronous.
  let inlineCandidates = 0;
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = await Promise.all(rows.slice(offset, offset + 8).map(async row => {
      const entry: ManagementEntry = { path: row.slice(3), index: row[0], working: row[1] };
      const inline = includeStats && entry.index === '?' && inlineCandidates++ < 16;
      try {
        await filePath(root, entry.path);
        if (inline) {
          // Optional enrichment must neither fail status nor bypass readSnapshot's path checks.
          try {
            const stat = await fs.lstat(path.join(root, entry.path));
            if (stat.size <= 16 * 1024) entry.stats = untrackedStat(entry.path, await readSnapshot(root, entry.path));
          } catch { /* Retry through the independent stats request if the file changed. */ }
        }
      } catch (error) { entry.blocked = (error as Error).message; }
      return entry;
    }));
    entries.push(...batch);
  }
  const result = { root, branch, head: head ?? null, entries };
  if (includeStats && Buffer.byteLength(JSON.stringify(result)) > 48000) for (const entry of entries) delete entry.stats;
  if (Buffer.byteLength(JSON.stringify(result)) > 48000) fail('GIT_LIMIT', 'Status exceeds the panel budget. Use the Git CLI.');
  return result;
}
async function branchName(root: string, value: unknown): Promise<string> {
  const name = text(value, 'Local branch name', 240).trim();
  if (name.startsWith('-') || name === 'HEAD' || name.includes('@{')) fail('INVALID_REF', 'Use a literal local branch name.');
  const check = await git(root, ['check-ref-format', '--branch', name], { allowFailure: true });
  if (check.code !== 0) fail('INVALID_REF', 'Invalid local branch name.');
  return name;
}
/** Literal local refs only; NUL fields preserve worktree paths containing whitespace/newlines. */
async function localBranches(root: string, name?: string): Promise<ManagementBranch[]> {
  const raw = await run(root, ['for-each-ref', ...(name === undefined ? ['--count=201'] : []),
    '--format=%(refname:strip=2)%00%(objectname)%00%(HEAD)%00%(worktreepath)%00', name === undefined ? 'refs/heads/' : `refs/heads/${name}`]);
  const fields = raw.split('\0'), result: ManagementBranch[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const branch = fields[i].replace(/^\n/, '');
    if (name !== undefined && branch !== name) continue;
    result.push({ name: branch, oid: fields[i + 1], current: fields[i + 2] === '*', ...(fields[i + 3] ? { worktreePath: fields[i + 3] } : {}) });
  }
  return result;
}
async function branchResult(root: string): Promise<ManagementBranchResult> {
  // The mutation has already succeeded. An optional read must never turn it into a failed write.
  try { return { ok: true, repository: await repositorySummary(root) }; }
  catch { return { ok: true, notice: '操作已完成，但仓库状态读取失败；请刷新核对，不要重复执行。' }; }
}
async function runBranch(root: string, args: string[]): Promise<void> {
  try { await run(root, args); }
  catch (cause) {
    const error = cause as Error & { code?: string };
    if (error.code === 'GIT_FAILED') {
      if (/already (?:checked out|used by worktree)|used by worktree|checked out at/i.test(error.message)) fail('BRANCH_IN_USE', error.message);
      if (/already exists/i.test(error.message)) fail('BRANCH_EXISTS', error.message);
      if (/not fully merged/i.test(error.message)) fail('UNMERGED_BRANCH', error.message);
      if (/cannot lock ref|\.lock.*(?:exists|permission denied)|unable to create.*\.lock/i.test(error.message)) fail('GIT_LOCKED', error.message);
    }
    throw cause;
  }
}
async function requireHead(root: string): Promise<string> {
  return await headCommit(root) ?? fail('NO_HEAD', 'This repository has no commits. Stage files and create the first commit.');
}
async function requireIdle(root: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const result = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (await fs.stat(result.stdout.toString().trim()).then(() => true, () => false)) fail('OPERATION_IN_PROGRESS', 'Finish or abort the existing merge/rebase/cherry-pick in your Git client first.');
  }
}
async function checkedDiffPaths(root: string, args: string[]): Promise<string[]> {
  const names = records((await git(root, [...args, '--name-only', '-z', ...diffFlags, '--'])).stdout);
  if (names.length > 500) fail('GIT_LIMIT', 'Too many changed paths to show safely.');
  for (const name of names) { assertPublicPath(name); await filePath(root, name); }
  return names;
}
/** Historical reads validate literal paths and tree modes, never today's working tree. */
function historicalPath(value: unknown): string {
  const rel = text(value, 'Repository-relative file path');
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.includes('\\') || rel.split('/').some(p => p === '.' || p === '..' || p === '')) fail('INVALID_PATH', 'Select an explicit repository-relative file.');
  assertPublicPath(rel);
  return rel;
}
async function commitComparison(root: string, ref: unknown) {
  const oid = await resolveCommit(root, text(ref, 'Commit reference'));
  const header = (await git(root, ['cat-file', 'commit', oid])).stdout.toString().split('\n\n')[0];
  const parent = header.split('\n').find(row => row.startsWith('parent '))?.slice(7) ?? null;
  return { oid, parent, base: ['diff-tree', '--root', '-r', '--no-commit-id', ...(parent ? [parent, oid] : [oid])] };
}
async function commitFiles(root: string, base: string[], rel?: string): Promise<ManagementCommitFile[]> {
  const fields = records((await git(root, [...base, '--raw', '--numstat', '-z', ...diffFlags, '--', ...(rel ? [rel] : [])])).stdout);
  const entries = new Map<string, ManagementCommitFile>();
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    if (row.startsWith(':')) {
      const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(row);
      if (!match || !fields[i + 1]) fail('GIT_FAILED', 'Could not parse historical file metadata.');
      const name = fields[++i];
      const entry: ManagementCommitFile = { path: name, status: match[3], additions: null, deletions: null, kind: 'unknown' };
      try {
        historicalPath(name);
        if (![match[1], match[2]].every(mode => ['000000', '100644', '100755'].includes(mode))) fail('NOT_FILE', 'Historical symlinks and submodules cannot be previewed.');
      } catch (cause) { entry.blocked = (cause as Error).message; }
      entries.set(name, entry);
    } else {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match || !entries.has(match[3])) fail('GIT_FAILED', 'Could not parse historical file statistics.');
      const entry = entries.get(match[3])!;
      if (match[1] === '-' || match[2] === '-') entry.kind = 'binary';
      else { entry.additions = Number(match[1]); entry.deletions = Number(match[2]); delete entry.kind; }
    }
  }
  if (entries.size > 500) fail('GIT_LIMIT', 'More than 500 files in this commit. Use the Git CLI.');
  const result = [...entries.values()];
  if (Buffer.byteLength(JSON.stringify(result)) > 46000) fail('GIT_LIMIT', 'Commit file list exceeds the panel budget. Use the Git CLI.');
  return result;
}
function untrackedStat(rel: string, snapshot: Awaited<ReturnType<typeof readSnapshot>>): ManagementStat {
  if (!snapshot.exists) return { path: rel, additions: null, deletions: null, kind: 'unknown' };
  if (snapshot.kind === 'large') return { path: rel, additions: null, deletions: null, kind: 'large' };
  if (snapshot.text === null) return { path: rel, additions: null, deletions: null, kind: snapshot.kind === 'binary' ? 'binary' : 'unknown' };
  let lines = 0;
  for (let i = 0; i < snapshot.text.length; i++) if (snapshot.text.charCodeAt(i) === 10) lines++;
  if (snapshot.text.length && !snapshot.text.endsWith('\n')) lines++;
  return { path: rel, additions: lines, deletions: 0 };
}
async function stats(root: string, scope: 'workspace' | 'staged', paths: string[]): Promise<{ entries: ManagementStat[] }> {
  const indexed = scope === 'workspace' ? new Set(records((await git(root, ['ls-files', '-z', '--', ...paths])).stdout)) : new Set(paths);
  const tracked = paths.filter(rel => indexed.has(rel));
  const raw = tracked.length ? (await git(root, ['diff', '--numstat', '-z', ...diffFlags, ...(scope === 'staged' ? ['--cached'] : []), '--', ...tracked])).stdout : Buffer.alloc(0);
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(raw).split(String.fromCharCode(0));
  const entries: ManagementStat[] = [];
  for (const record of fields.slice(0, -1)) {
    const parts = record.split(String.fromCharCode(9));
    if (parts.length < 3) continue;
    const [adds, dels] = parts; const name = parts.slice(2).join(String.fromCharCode(9));
    await filePath(root, name);
    entries.push(adds === '-' || dels === '-' ? { path: name, additions: null, deletions: null, kind: 'binary' }
      : { path: name, additions: Number(adds), deletions: Number(dels) });
  }
  if (scope === 'workspace') {
    const untracked = paths.filter(rel => !indexed.has(rel));
    for (let offset = 0; offset < untracked.length; offset += 8) {
      entries.push(...await Promise.all(untracked.slice(offset, offset + 8).map(async rel => untrackedStat(rel, await readSnapshot(root, rel)))));
    }
  }
  for (const rel of paths) if (!entries.some(entry => entry.path === rel)) entries.push({ path: rel, additions: 0, deletions: 0 });
  if (Buffer.byteLength(JSON.stringify({ entries })) > 48000) fail('GIT_LIMIT', 'Statistics exceed the panel budget. Request fewer paths.');
  return { entries };
}
async function stashes(root: string): Promise<ManagementStash[]> {
  const raw = await run(root, ['stash', 'list', '-100', '--format=%gd%x00%H%x00%gs%x00']);
  const fields = raw.split('\0'); const result: ManagementStash[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) result.push({ ref: fields[i].trim(), oid: fields[i + 1], subject: fields[i + 2].slice(0, 180) });
  return result;
}
async function stashTarget(root: string, args: ManagementArgs): Promise<ManagementStash> {
  if (typeof args.ref !== 'string' || !/^stash@\{\d+\}$/.test(args.ref)) fail('INVALID_REF', 'Select a stash from the refreshed list.');
  const stash = (await stashes(root)).find(item => item.ref === args.ref);
  if (!stash) fail('STALE_STASH', 'Stash no longer exists. Refresh the list.');
  if (args.oid !== stash.oid) fail('STALE_STASH', 'Stash changed. Refresh and confirm the selected stash again.');
  return stash;
}
async function safeStashPaths(root: string, oid: string): Promise<void> {
  await checkedDiffPaths(root, ['diff', `${oid}^1`, oid]);
  const third = await git(root, ['rev-parse', '--verify', '--quiet', `${oid}^3`], { allowFailure: true });
  if (third.code === 0) {
    const names = records((await git(root, ['ls-tree', '-r', '--name-only', '-z', third.stdout.toString().trim(), '--'])).stdout);
    for (const name of names) await filePath(root, name);
  }
}

function commitMessage(args: ManagementArgs): string {
  if (args.summary === undefined && args.paths === undefined && args.scope === undefined) return text(args.message, 'Commit message', 5000).trim();
  const rawSummary = text(args.summary, 'Commit summary', 240);
  if (/[\r\n]/.test(rawSummary)) fail('INVALID_ARGUMENT', 'Commit summary must be a single line.');
  const summary = rawSummary.trim();
  if (args.description !== undefined && (typeof args.description !== 'string' || args.description.includes('\0') || args.description.length > 4500)) fail('INVALID_ARGUMENT', 'Invalid commit description.');
  return text(summary + (args.description?.trim() ? `\n\n${args.description.trim()}` : ''), 'Commit message', 5000);
}
async function indexBytes(index: string): Promise<Buffer | undefined> {
  return fs.readFile(index).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
}
function sameIndex(left?: Buffer, right?: Buffer): boolean { return left === undefined ? right === undefined : right !== undefined && left.equals(right); }
async function selectedCommit(root: string, args: ManagementArgs, message: string, state: ManagementStatus) {
  if (args.scope !== 'workspace' && args.scope !== 'staged') fail('INVALID_SCOPE', 'Choose workspace or staged for the selected commit.');
  const paths = await selected(root, args.paths);
  for (const rel of paths) {
    const entry = state.entries.find(item => item.path === rel);
    if (!entry || entry.blocked || (args.scope === 'staged' ? [' ', '?'].includes(entry.index) : entry.working === ' ')) fail('STALE_PATH', 'Selected file is no longer actionable. Refresh before committing.');
  }
  const previous = await headCommit(root);
  const realIndex = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.toString().trim();
  const original = await indexBytes(realIndex);
  const token = `diff-view-commit-${randomUUID()}`, isolated = path.join(path.dirname(realIndex), `${token}.index`), nextIndex = `${isolated}.next`;
  let lock: fs.FileHandle | undefined, ownsLock = false;
  try {
    await git(root, ['read-tree', ...(previous ? [previous] : ['--empty'])], { index: isolated });
    if (args.scope === 'workspace') await run(root, ['add', '--', ...paths], false, isolated);
    else {
      const rows = records((await git(root, ['ls-files', '--stage', '-z', '--', ...paths])).stdout);
      if (rows.some(row => !/^(100644|100755) [a-f0-9]{40,64} 0\t/.test(row))) fail('NOT_FILE', 'Selected index paths must be ordinary non-conflicted files.');
      await git(root, ['update-index', '--force-remove', '--', ...paths], { index: isolated });
      if (rows.length) await git(root, ['update-index', '-z', '--index-info'], { index: isolated, input: Buffer.from(rows.join('\0') + '\0') });
    }
    const changes = await git(root, ['diff', '--cached', '--quiet', '--exit-code', ...diffFlags, '--'], { index: isolated, allowFailure: true });
    if (changes.code === 0) fail('NOTHING_SELECTED', 'Selected files contain no changes to commit.');
    if (changes.code !== 1) fail('GIT_FAILED', 'Could not verify selected commit content.');
    if (await headCommit(root) !== previous) fail('FILE_CHANGED', 'HEAD changed while preparing the commit. Refresh first.');
    const result = await run(root, ['commit', '-m', message], true, isolated);
    const oid = await headCommit(root);
    if (!oid || oid === previous) fail('COMMIT_NOT_CREATED', 'Git did not create a new commit. Inspect hook output and refresh.');
    let notice: string | undefined;
    // Prepare a copy of the original index, changing only the committed paths.
    // Use the actual index.lock protocol and compare bytes before publishing it.
    // Any failure after a real commit is a notice, not a request to retry the commit.
    try {
      if (original) await fs.writeFile(nextIndex, original); else await git(root, ['read-tree', '--empty'], { index: nextIndex });
      await git(root, ['reset', '-q', oid, '--', ...paths], { index: nextIndex });
      lock = await fs.open(`${realIndex}.lock`, 'wx'); ownsLock = true;
      if (!sameIndex(original, await indexBytes(realIndex))) notice = '提交已成功，但索引在提交期间被外部修改；已保留外部暂存，请刷新核对。';
      else {
        await lock.writeFile(await fs.readFile(nextIndex)); await lock.close(); lock = undefined;
        await fs.rename(`${realIndex}.lock`, realIndex); ownsLock = false;
      }
    } catch { notice = '提交已成功，但无法同步所选文件的索引；已保留原索引，请刷新后使用 Git CLI 核对。'; }
    return { ok: true, oid, ...output(result, notice) };
  } finally {
    await lock?.close().catch(() => undefined);
    if (ownsLock) await fs.unlink(`${realIndex}.lock`).catch(() => undefined);
    for (const file of [isolated, `${isolated}.lock`, nextIndex, `${nextIndex}.lock`]) await fs.unlink(file).catch(() => undefined);
  }
}

async function discardTarget(root: string, values: unknown) {
  const paths = await selected(root, values);
  if (paths.length !== 1) fail('INVALID_PATH', 'Discard requires exactly one explicit file.');
  const rel = paths[0], state = await status(root);
  const entry = state.entries.find(item => item.path === rel);
  if (!entry || entry.blocked || entry.working === ' ') fail('STALE_PATH', 'File has no actionable working-tree change. Refresh first.');
  if (entry.index === 'U' || entry.working === 'U' || ['AA', 'DD'].includes(entry.index + entry.working)) fail('CONFLICT', 'Resolve conflicts in your Git client before discarding.');
  const index = await run(root, ['ls-files', '--stage', '-z', '--', rel]);
  if (index && !/^(100644|100755) /.test(index)) fail('NOT_FILE', 'Only regular index files can be restored.');
  if (entry.index !== '?' && !index) fail('STALE_PATH', 'No regular index version exists. Review this path in Git CLI.');
  const snapshot = await readSnapshot(root, rel);
  if (snapshot.kind === 'large') fail('GIT_LIMIT', 'File exceeds the safe discard snapshot limit. Use Git CLI.');
  const fingerprint = digest(JSON.stringify([entry.index, entry.working, index, snapshot.exists, snapshot.hash, snapshot.mode]));
  return { rel, fingerprint, untracked: entry.index === '?' };
}

export class LocalGitManagement {
  /** method MUST be gitManage. allowedRoots MUST come from the host, never the renderer.
   * root defaults only when exactly one root is authorized; enclosing repos are never adopted.
   * Returns operation-specific JSON or throws Error with code/message. Writes are exclusive per root.
   */
  async dispatch(method: string, value: unknown, allowedRoots: readonly string[]): Promise<unknown> {
    if (method !== 'gitManage') fail('INVALID_METHOD', 'Unsupported local Git method.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', 'Git management arguments are required.');
    const args = value as ManagementArgs;
    if (!operations.has(args.operation)) fail('INVALID_OPERATION', 'Unsupported local-only Git operation.');
    const roots = await Promise.all(allowedRoots.map(root => fs.realpath(root)));
    const requested = args.root ?? (roots.length === 1 ? roots[0] : fail('ROOT_REQUIRED', 'Select an authorized project root.'));
    const root = await fs.realpath(text(requested, 'Project root')).catch(() => fail('INVALID_ROOT', 'Project directory is unavailable. Open an existing project.'));
    if (!roots.some(allowed => canonical(allowed) === canonical(root))) fail('ROOT_DENIED', 'Repository is not an authorized project root.');
    const key = canonical(root);
    const queue = queues.get(key) ?? new ReadWriteQueue(4); queues.set(key, queue);
    const pending = queue.run(async () => {
      if (!(await discoverRepository(root, false)).git) fail('NO_REPOSITORY', 'Selected project is not a Git root. Open the repository root; enclosing repositories are not authorized.');
      if (confirmation.has(args.operation) && args.confirmed !== true) fail('CONFIRM_REQUIRED', 'Confirm this operation in the Git panel before continuing.');
      if (mutations.has(args.operation)) await requireIdle(root);
      return this.perform(root, args);
    }, mutations.has(args.operation));
    try { return await pending; } finally { if (queue.pending === 0 && queues.get(key) === queue) queues.delete(key); }
  }
  private async perform(root: string, args: ManagementArgs, repository?: Promise<ManagementRepository>): Promise<unknown> {
    const op = args.operation;
    if (args.includeRepository === true && ['branches', 'history', 'stashList'].includes(op)) {
      const summary = repositorySummary(root);
      // Keep the repository fence until every child read has settled, even on failure.
      const results = await Promise.allSettled([summary, this.perform(root, { ...args, includeRepository: false }, summary)]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      return { ...(results[1] as PromiseFulfilledResult<object>).value, repository: (results[0] as PromiseFulfilledResult<ManagementRepository>).value };
    }
    if (op === 'status') return args.summaryOnly === true ? { ...await repositorySummary(root), entries: [] } : status(root, args.includeStats === true);
    if (op === 'discardPreview' || op === 'discard') {
      const target = await discardTarget(root, args.paths);
      if (op === 'discardPreview') return { fingerprint: target.fingerprint, untracked: target.untracked };
      if (args.fingerprint !== target.fingerprint) fail('FILE_CHANGED', 'File or index changed since confirmation. Refresh and review before discarding.');
      if (target.untracked) await fs.unlink(await safeResolve(root, target.rel));
      else await run(root, ['restore', '--worktree', '--', target.rel]);
      return { ok: true };
    }
    if (op === 'diff') {
      if (args.scope !== 'workspace' && args.scope !== 'staged') fail('INVALID_SCOPE', 'Choose workspace or staged.');
      const paths = await selected(root, args.paths);
      let patch = await run(root, ['diff', ...diffFlags, ...(args.scope === 'staged' ? ['--cached'] : []), '--', ...paths]);
      if (args.scope === 'workspace') {
        const indexed = new Set(records((await git(root, ['ls-files', '-z', '--', ...paths])).stdout));
        for (const rel of paths.filter(item => !indexed.has(item))) {
          const snapshot = await readSnapshot(root, rel);
          if (snapshot.exists) patch += snapshot.text === null ? `\n${rel}: binary or oversized untracked file (no text preview).\n` : createTwoFilesPatch('/dev/null', rel, '', snapshot.text);
        }
      }
      return output(patch);
    }
    if (op === 'stats') {
      if (args.scope !== 'workspace' && args.scope !== 'staged') fail('INVALID_SCOPE', 'Choose workspace or staged.');
      return stats(root, args.scope, await selected(root, args.paths));
    }
    if (op === 'stage' || op === 'unstage') {
      const paths = await selected(root, args.paths);
      const state = await status(root);
      for (const rel of paths) {
        const entry = state.entries.find(item => item.path === rel);
        if (!entry || entry.blocked || (op === 'unstage' && [' ', '?'].includes(entry.index))) fail('STALE_PATH', 'Selection is no longer actionable. Refresh and select changed files.');
      }
      if (op === 'stage') await run(root, ['add', '--', ...paths]);
      else if (await headCommit(root)) await run(root, ['reset', '-q', 'HEAD', '--', ...paths]);
      else await run(root, ['rm', '--cached', '-q', '-f', '--', ...paths]); // unborn index only; never working files
      return { ok: true };
    }
    if (op === 'commit') {
      const message = commitMessage(args);
      const state = await status(root);
      if (state.entries.some(e => e.index === 'U' || e.working === 'U' || ['AA', 'DD'].includes(e.index + e.working))) fail('CONFLICT', 'Resolve and stage all conflicts before committing.');
      if (args.paths !== undefined || args.scope !== undefined || args.summary !== undefined) return selectedCommit(root, args, message, state);
      const staged = state.entries.filter(e => ![' ', '?'].includes(e.index));
      if (!staged.length) fail('NOTHING_STAGED', 'Nothing is staged. Select files and stage them first.');
      if (staged.some(e => e.blocked)) fail('PATH_DENIED', 'The index contains protected or unsupported paths. Review them in the Git CLI before committing.');
      const previous = await headCommit(root);
      const result = await run(root, ['commit', '-m', message], true);
      const oid = await headCommit(root);
      if (!oid || oid === previous) fail('COMMIT_NOT_CREATED', 'Git did not create a new commit. Inspect hook output and refresh.');
      return { ok: true, oid, ...output(result) };
    }
    if (op === 'branches') {
      const branches = await localBranches(root);
      return { branches: branches.slice(0, 200), truncated: branches.length > 200 };
    }
    if (op.startsWith('branch')) {
      const name = await branchName(root, args.name);
      const before = await repositorySummary(root);
      if (!before.head) fail('NO_HEAD', 'This repository has no commits. Stage files and create the first commit.');
      if ((args.expectedHead !== undefined && args.expectedHead !== before.head) || (args.expectedBranch !== undefined && args.expectedBranch !== before.branch)) fail('STALE_BRANCH', 'HEAD or current branch changed since confirmation. Refresh and confirm again.');
      if (op === 'branchCreate') await runBranch(root, ['branch', '--', name, await resolveCommit(root, args.ref ?? 'HEAD')]);
      else {
        const target = (await localBranches(root, name))[0];
        if (!target) fail('BRANCH_NOT_FOUND', 'The selected local branch no longer exists. Refresh the branch list.');
        if (args.oid !== undefined && args.oid !== target.oid) fail('STALE_BRANCH', 'The selected branch changed since confirmation. Refresh and confirm again.');
        if (op === 'branchDelete' && before.branch === name) fail('CURRENT_BRANCH', 'Cannot delete the current branch. Switch to another branch first.');
        if (target.worktreePath && canonical(target.worktreePath) !== canonical(root)) fail('BRANCH_IN_USE', `Branch is in use by another worktree: ${target.worktreePath}`);
        if (op === 'branchSwitch') {
          await runBranch(root, ['switch', '--no-guess', '--', name]);
        } else if (op === 'branchRename') {
          const next = await branchName(root, args.newName);
          if (next !== name) {
            if ((await localBranches(root, next)).length) fail('BRANCH_EXISTS', 'The target local branch already exists. Choose another name.');
            await runBranch(root, ['branch', '-m', '--', name, next]);
          }
        } else if (op === 'branchDelete') {
          const merged = await git(root, ['merge-base', '--is-ancestor', target.oid, before.head], { allowFailure: true });
          if (merged.code === 1) fail('UNMERGED_BRANCH', 'Branch is not fully merged into HEAD. Safe deletion refused; no force deletion is available.');
          if (merged.code !== 0) fail('GIT_FAILED', 'Could not verify whether this branch is merged. Nothing was deleted.');
          // Recheck after the ancestry read; native -d still supplies the final Git safety checks.
          const latest = await repositorySummary(root), selected = (await localBranches(root, name))[0];
          if (latest.head !== before.head || latest.branch !== before.branch || selected?.oid !== target.oid) fail('STALE_BRANCH', 'Repository changed while checking safe deletion. Refresh and confirm again.');
          await runBranch(root, ['branch', '-d', '--', name]);
        }
      }
      return branchResult(root);
    }
    if (op === 'history') {
      if (!(repository ? (await repository).head : await headCommit(root))) return { commits: [], hasMore: false, notice: 'No commits yet. Stage files and create the first commit.' };
      const skip = args.skip ?? 0, limit = args.limit ?? 30;
      if (!Number.isInteger(skip) || skip < 0 || skip > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT', 'History requires skip 0–100000 and limit 1–100.');
      const raw = await run(root, ['log', `--skip=${skip}`, `--max-count=${limit + 1}`, '--format=%H%x00%an%x00%aI%x00%s%x00', 'HEAD', '--']);
      const fields = raw.split('\0'); const commits: ManagementCommit[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ oid: fields[i].trim(), author: fields[i + 1].slice(0, 120), date: fields[i + 2], subject: fields[i + 3].slice(0, 180) });
      return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
    }
    if (op === 'commitFiles' || op === 'commitDiff') {
      const { oid, parent, base } = await commitComparison(root, args.ref);
      if (op === 'commitFiles') return { oid, parent, entries: await commitFiles(root, base) } satisfies ManagementCommitFiles;
      if (args.path !== undefined) {
        const rel = historicalPath(args.path);
        const entry = (await commitFiles(root, base, rel)).find(item => item.path === rel);
        if (!entry) fail('STALE_PATH', 'Selected file is not changed in this commit.');
        if (entry.blocked) fail('PATH_DENIED', entry.blocked);
        return output(await run(root, [...base, '-p', ...diffFlags, '--', rel]));
      }
      // Keep the existing whole-commit operation for older callers.
      await checkedDiffPaths(root, base);
      return output(await run(root, [...base, '-p', ...diffFlags, '--']), 'Compared with the first parent (or the empty tree for the first commit).');
    }
    if (op === 'blame') {
      const rel = await filePath(root, args.path);
      const oid = args.ref ? await resolveCommit(root, args.ref) : await requireHead(root);
      return output(await run(root, ['blame', '--no-textconv', '--date=short', oid, '--', rel]), 'Committed content only; workspace edits are not included.');
    }
    if (op === 'stashList') return { stashes: await stashes(root), notice: 'Showing at most 100 stashes.' };
    if (op === 'stashCreate') {
      await requireHead(root);
      const state = await status(root);
      const affected = state.entries.filter(e => args.includeUntracked === true || e.index !== '?');
      if (!affected.length) fail('NOTHING_TO_STASH', 'No matching changes. Enable untracked files if needed.');
      if (affected.some(e => e.blocked)) fail('PATH_DENIED', 'Stash would touch protected or unsupported paths. Use the Git CLI.');
      const before = (await stashes(root))[0]?.oid;
      const message = args.message === undefined || args.message === '' ? 'Local Git management' : text(args.message, 'Stash message', 1000);
      await run(root, ['stash', 'push', ...(args.includeUntracked === true ? ['--include-untracked'] : []), '-m', message]);
      const after = (await stashes(root))[0];
      if (!after || after.oid === before) fail('STASH_NOT_CREATED', 'No new stash was created. Refresh and inspect Git status.');
      const remaining = (await status(root)).entries.filter(e => args.includeUntracked === true || e.index !== '?');
      if (remaining.length) fail('STASH_INCOMPLETE', 'A stash was saved, but changes remain in the worktree. Inspect status and the stash before retrying.');
      return { ok: true, stash: after };
    }
    if (['stashShow', 'stashApply', 'stashPop', 'stashDrop'].includes(op)) {
      const stash = await stashTarget(root, args);
      if (op === 'stashShow') {
        await safeStashPaths(root, stash.oid);
        return output(await run(root, ['stash', 'show', '--include-untracked', '-p', ...diffFlags, stash.oid]));
      }
      if (op !== 'stashDrop') {
        await safeStashPaths(root, stash.oid);
        if ((await status(root)).entries.length) fail('DIRTY_WORKTREE', 'Commit or stash current changes before applying a stash, to avoid mixing unrelated work.');
      }
      if (op !== 'stashDrop') {
        try { await run(root, ['stash', 'apply', stash.oid]); }
        catch (error) { fail('STASH_CONFLICT', `${(error as Error).message}\nStash was not dropped. Inspect status and resolve any conflicts manually; do not retry automatically.`); }
      }
      if (op === 'stashPop' || op === 'stashDrop') {
        // Applying an immutable OID avoids applying a different stash after a concurrent push.
        // Recheck the reflog slot before deleting; on a race, keep the stash and report it.
        await stashTarget(root, args);
        await run(root, ['stash', 'drop', stash.ref]);
      }
      return { ok: true };
    }
    fail('INVALID_OPERATION', 'Unsupported Git operation.');
  }
}
const localManagement = new LocalGitManagement();
export const dispatch = (method: string, args: unknown, allowedRoots: readonly string[]): Promise<unknown> => localManagement.dispatch(method, args, allowedRoots);
