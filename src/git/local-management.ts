import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
import { assertPublicPath, canonical, digest, fail, readSnapshot, safeResolve } from '../core/path-policy';
import { discoverRepository } from './repository';
import { git, headCommit, resolveCommit } from './runner';

/** Independent human-UI API; never uses session records. See dispatch() for the operation vocabulary.
 * Reference: official PI-Desktop pi.gitlens 0.2.7 (main.js/git.js/renderer/panel.js),
 * not the third-party IDEA Git plugin. This implementation does not copy its source.
 */
export interface ManagementEntry { path: string; index: string; working: string; blocked?: string; }
export interface ManagementStatus { root: string; branch: string | null; head: string | null; entries: ManagementEntry[]; }
export interface ManagementBranch { name: string; oid: string; current: boolean; }
export interface ManagementCommit { oid: string; author: string; date: string; subject: string; }
export interface ManagementStash { ref: string; oid: string; subject: string; }
export interface ManagementText { text: string; truncated: boolean; notice?: string; }
export interface ManagementArgs {
  operation: string; root?: string; paths?: string[]; path?: string; scope?: 'workspace' | 'staged';
  message?: string; name?: string; newName?: string; ref?: string; oid?: string;
  confirmed?: boolean; includeUntracked?: boolean; skip?: number; limit?: number;
  fingerprint?: string;
}
const mutations = new Set(['stage', 'unstage', 'discard', 'commit', 'branchCreate', 'branchSwitch', 'branchRename', 'branchDelete', 'stashCreate', 'stashApply', 'stashPop', 'stashDrop']);
const confirmation = new Set(['discard', 'commit', 'branchSwitch', 'branchRename', 'branchDelete', 'stashCreate', 'stashApply', 'stashPop', 'stashDrop']);
const operations = new Set(['status', 'diff', 'discardPreview', 'branches', 'history', 'commitDiff', 'blame', 'stashList', 'stashShow', ...mutations]);
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
const queues = new Map<string, Promise<unknown>>();
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
async function run(root: string, args: string[], hooks = false): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C' });
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
async function status(root: string): Promise<ManagementStatus> {
  const [raw, head, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']), headCommit(root),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
  ]);
  const rows = records(raw.stdout);
  if (rows.length > 500) fail('GIT_LIMIT', 'More than 500 changed files. Use the Git CLI or narrow this repository.');
  const entries: ManagementEntry[] = [];
  for (const row of rows) {
    const entry: ManagementEntry = { path: row.slice(3), index: row[0], working: row[1] };
    try { await filePath(root, entry.path); } catch (error) { entry.blocked = (error as Error).message; }
    entries.push(entry);
  }
  const result = { root, branch: branch.code === 0 ? branch.stdout.toString().trim() : null, head: head ?? null, entries };
  if (Buffer.byteLength(JSON.stringify(result)) > 48000) fail('GIT_LIMIT', 'Status exceeds the panel budget. Use the Git CLI.');
  return result;
}
async function branchName(root: string, value: unknown): Promise<string> {
  const name = text(value, 'Local branch name', 240);
  if (name.startsWith('-') || name === 'HEAD' || name.includes('@{')) fail('INVALID_REF', 'Use a literal local branch name.');
  const check = await git(root, ['check-ref-format', '--branch', name], { allowFailure: true });
  if (check.code !== 0) fail('INVALID_REF', 'Invalid local branch name.');
  return name;
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
   * Returns operation-specific JSON or throws Error with code/message. Serialize through one instance.
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
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      if (!(await discoverRepository(root, false)).git) fail('NO_REPOSITORY', 'Selected project is not a Git root. Open the repository root; enclosing repositories are not authorized.');
      if (confirmation.has(args.operation) && args.confirmed !== true) fail('CONFIRM_REQUIRED', 'Confirm this operation in the Git panel before continuing.');
      if (mutations.has(args.operation)) await requireIdle(root);
      return this.perform(root, args);
    });
    queues.set(key, pending);
    try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
  }
  private async perform(root: string, args: ManagementArgs): Promise<unknown> {
    const op = args.operation;
    if (op === 'status') return status(root);
    if (op === 'discardPreview' || op === 'discard') {
      const target = await discardTarget(root, args.paths);
      if (op === 'discardPreview') return { fingerprint: target.fingerprint, untracked: target.untracked };
      if (args.fingerprint !== target.fingerprint) fail('FILE_CHANGED', 'File or index changed since confirmation. Refresh and review before discarding.');
      if (target.untracked) await fs.unlink(await safeResolve(root, target.rel));
      else await run(root, ['restore', '--worktree', '--', target.rel]);
      return { ok: true };
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
    if (op === 'diff') {
      if (args.scope !== 'workspace' && args.scope !== 'staged') fail('INVALID_SCOPE', 'Choose workspace or staged.');
      const paths = await selected(root, args.paths);
      let patch = await run(root, ['diff', ...diffFlags, ...(args.scope === 'staged' ? ['--cached'] : []), '--', ...paths]);
      if (args.scope === 'workspace') {
        const state = await status(root);
        for (const rel of paths.filter(rel => state.entries.some(e => e.path === rel && e.index === '?'))) {
          const snapshot = await readSnapshot(root, rel);
          patch += snapshot.text === null ? `\n${rel}: binary or oversized untracked file (no text preview).\n`
            : createTwoFilesPatch('/dev/null', rel, '', snapshot.text);
        }
      }
      return output(patch);
    }
    if (op === 'commit') {
      const message = text(args.message, 'Commit message', 5000).trim();
      const state = await status(root);
      if (state.entries.some(e => e.index === 'U' || e.working === 'U' || ['AA', 'DD'].includes(e.index + e.working))) fail('CONFLICT', 'Resolve and stage all conflicts before committing.');
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
      const raw = await run(root, ['for-each-ref', '--count=201', '--format=%(refname:strip=2)%00%(objectname)%00%(HEAD)', 'refs/heads/']);
      const branches = raw.trimEnd().split('\n').filter(Boolean).map(row => { const [name, oid, current] = row.split('\0'); return { name, oid, current: current === '*' }; });
      return { branches: branches.slice(0, 200), truncated: branches.length > 200 };
    }
    if (op.startsWith('branch')) {
      const name = await branchName(root, args.name);
      await requireHead(root);
      if (op === 'branchCreate') await run(root, ['branch', '--', name, await resolveCommit(root, args.ref ?? 'HEAD')]);
      else {
        await resolveCommit(root, `refs/heads/${name}`);
        if (op === 'branchSwitch') {
          if ((await status(root)).entries.length) fail('DIRTY_WORKTREE', 'Branch switching is blocked while staged, unstaged or untracked changes exist. Commit or stash them first.');
          await run(root, ['switch', '--no-guess', '--', name]);
        } else if (op === 'branchRename') await run(root, ['branch', '-m', '--', name, await branchName(root, args.newName)]);
        else if (op === 'branchDelete') {
          const merged = await git(root, ['merge-base', '--is-ancestor', `refs/heads/${name}`, 'HEAD'], { allowFailure: true });
          if (merged.code !== 0) fail('UNMERGED_BRANCH', 'Branch is not fully merged into HEAD. Safe deletion refused; no force deletion is available.');
          await run(root, ['branch', '-d', '--', name]);
        }
      }
      return { ok: true };
    }
    if (op === 'history') {
      if (!await headCommit(root)) return { commits: [], hasMore: false, notice: 'No commits yet. Stage files and create the first commit.' };
      const skip = args.skip ?? 0, limit = args.limit ?? 30;
      if (!Number.isInteger(skip) || skip < 0 || skip > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT', 'History requires skip 0–100000 and limit 1–100.');
      const raw = await run(root, ['log', `--skip=${skip}`, `--max-count=${limit + 1}`, '--format=%H%x00%an%x00%aI%x00%s%x00', 'HEAD', '--']);
      const fields = raw.split('\0'); const commits: ManagementCommit[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ oid: fields[i].trim(), author: fields[i + 1].slice(0, 120), date: fields[i + 2], subject: fields[i + 3].slice(0, 180) });
      return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
    }
    if (op === 'commitDiff') {
      await requireHead(root);
      const oid = await resolveCommit(root, text(args.ref, 'Commit reference'));
      const header = (await git(root, ['cat-file', 'commit', oid])).stdout.toString().split('\n\n')[0];
      const parent = header.split('\n').find(row => row.startsWith('parent '))?.slice(7);
      const base = ['diff-tree', '--root', '-r', '--no-commit-id', ...(parent ? [parent, oid] : [oid])];
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
