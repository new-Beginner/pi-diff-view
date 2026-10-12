import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyGitAction } from '../../src/git/actions';
import { discoverRepository, readGitReview, type GitReview } from '../../src/git/repository';
import { git as boundedGit } from '../../src/git/runner';
import { buildHunks, selectHunkText } from '../../src/core/diff';
import { MAX_TEXT_BYTES, type Action } from '../../src/core/contracts';

const exec = promisify(execFile);
let container: string, root: string;
async function command(args: string[], cwd = root): Promise<Buffer> {
  const { stdout } = await exec('git', ['-c', 'user.name=PI Test', '-c', 'user.email=pi-test@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 15000, windowsHide: true,
  });
  return stdout;
}
async function write(rel: string, bytes: string | Buffer, cwd = root) {
  await fs.mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
  await fs.writeFile(path.join(cwd, rel), bytes);
}
async function commit() { await command(['add', '--all', '--']); await command(['commit', '-m', 'fixture']); }
async function indexed(rel: string, cwd = root) { return (await command(['show', `:${rel}`], cwd)).toString('utf8'); }
function file(review: GitReview, rel: string) {
  const found = review.files.find(f => f.path === rel);
  if (!found) throw new Error(`Missing reviewed file ${rel}`);
  return found;
}
async function act(review: GitReview, rel: string, action: Action, hunkId?: string) {
  const f = file(review, rel);
  await applyGitAction(review, f.id, action, f.fingerprint, hunkId, path.join(container, 'backups'));
}
const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
const changed = original.replace('line 2\n', 'insert A\ninsert B\nline 2 edited\n').replace('line 25\n', 'line 25 edited\n');

beforeEach(async () => {
  container = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-git-'));
  root = path.join(container, 'repo'); await fs.mkdir(root);
  await command(['init', '-b', 'main']);
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

describe('bounded literal-byte Git backend', () => {
  it('keeps selected subprojects authorized without exposing an enclosing repository', async () => {
    await write('outside.txt', 'outside'); await write('project/inside.txt', 'inside');
    const project = path.join(root, 'project');
    const info = await discoverRepository(project);
    expect(info.root).toBe(await fs.realpath(project)); expect(info.git).toBe(false);
    const review = await readGitReview(project, 'unstaged');
    expect(review.files).toEqual([]); expect(review.notice).toContain('not authorized');
    expect((await discoverRepository(root)).git).toBe(true);
  });

  it('stages and unstages an unborn HEAD, preserving working bytes and other entries', async () => {
    await write('new.txt', 'new\r\n'); await write('other.txt', 'other');
    await command(['add', '--', 'other.txt']);
    await act(await readGitReview(root, 'unstaged'), 'new.txt', 'stage');
    expect(await indexed('new.txt')).toBe('new\r\n');
    const review = await readGitReview(root, 'staged');
    expect(review.notice).toContain('Unborn HEAD'); expect(file(review, 'new.txt').before.exists).toBe(false);
    await act(review, 'new.txt', 'unstage');
    expect((await command(['ls-files', '-z'])).toString()).toBe('other.txt\0');
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new\r\n');
  });

  it('handles Unicode, spaces and literal special pathspecs without BOM/CRLF conversion', async () => {
    const names = process.platform === 'win32' ? ['目录/中文 空格.txt', '-option.txt', '[glob] $&.txt']
      : ['目录/中文 空格.txt', '-option.txt', '[glob] $&.txt', ':(glob)literal', 'tab\tname.txt'];
    for (const name of names) await write(name, '\ufeff你好\r\nlast');
    for (const name of names) {
      const review = await readGitReview(root, 'unstaged');
      expect(file(review, name).after.text).toBe('\ufeff你好\r\nlast');
      await act(review, name, 'stage'); expect(await indexed(name)).toBe('\ufeff你好\r\nlast');
    }
  });

  it('stages one of two separated hunks in a partially staged file, retaining unrelated index flags', async () => {
    await write('a.txt', original); await write('keep.txt', 'keep'); await commit();
    await command(['update-index', '--skip-worktree', '--', 'keep.txt']);
    const partly = original.replace('line 15\n', 'already staged\n');
    await write('a.txt', partly); await command(['add', '--', 'a.txt']);
    const working = partly.replace('line 2\n', 'first edit\n').replace('line 25\n', 'second edit\n');
    await write('a.txt', working);
    const review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    expect(f.before.text).toBe(partly);
    const hunks = buildHunks(f.before.text!, f.after.text!); expect(hunks).toHaveLength(2);
    await act(review, 'a.txt', 'stage', hunks[1].id);
    expect(await indexed('a.txt')).toBe(selectHunkText(partly, working, hunks[1].id));
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(working);
    expect((await command(['ls-files', '-v', '--', 'keep.txt'])).toString()).toContain('S keep.txt');
  });

  it('unstages only the original-coordinate second hunk and never touches working text', async () => {
    await write('a.txt', original); await commit();
    await write('a.txt', changed); await command(['add', '--', 'a.txt']);
    const working = `${changed}extra unstaged text\n`; await write('a.txt', working);
    const review = await readGitReview(root, 'staged'), f = file(review, 'a.txt');
    const hunks = buildHunks(f.before.text!, f.after.text!); expect(hunks).toHaveLength(2);
    await act(review, 'a.txt', 'unstage', hunks[1].id);
    expect(await indexed('a.txt')).toBe(selectHunkText(original, changed, hunks[0].id));
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(working);
  });

  it('reverts an insertion hunk using original coordinates, preserving the later edit and index', async () => {
    await write('a.txt', original); await commit(); await write('a.txt', changed);
    const review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    const hunks = buildHunks(f.before.text!, f.after.text!); expect(hunks).toHaveLength(2);
    const indexBefore = await fs.readFile(path.join(root, '.git/index'));
    await act(review, 'a.txt', 'revert', hunks[0].id);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(selectHunkText(original, changed, hunks[1].id));
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
    expect((await fs.readdir(path.join(container, 'backups'))).length).toBeGreaterThan(0);
  });

  it('supports guarded whole-file deletion/restoration and new-file rollback', async () => {
    await write('gone.txt', 'restore me\n'); await commit(); await fs.unlink(path.join(root, 'gone.txt'));
    let review = await readGitReview(root, 'unstaged'); expect(file(review, 'gone.txt').status).toBe('deleted');
    await act(review, 'gone.txt', 'revert'); expect(await fs.readFile(path.join(root, 'gone.txt'), 'utf8')).toBe('restore me\n');
    await fs.unlink(path.join(root, 'gone.txt')); await act(await readGitReview(root, 'unstaged'), 'gone.txt', 'stage');
    review = await readGitReview(root, 'staged'); expect(file(review, 'gone.txt').after.exists).toBe(false);
    await act(review, 'gone.txt', 'unstage'); expect(await indexed('gone.txt')).toBe('restore me\n');
    await expect(fs.stat(path.join(root, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await write('new.txt', 'new'); await act(await readGitReview(root, 'unstaged'), 'new.txt', 'revert');
    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale index snapshots with no index or working-tree changes', async () => {
    await write('a.txt', 'base'); await write('b.txt', 'base'); await commit(); await write('a.txt', 'edit');
    const review = await readGitReview(root, 'unstaged');
    await write('b.txt', 'someone staged'); await command(['add', '--', 'b.txt']);
    const indexBefore = await fs.readFile(path.join(root, '.git/index'));
    await expect(act(review, 'a.txt', 'stage')).rejects.toMatchObject({ code: 'STALE_INDEX' });
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('edit');
    await expect(fs.stat(path.join(root, '.git/index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['stage', 'revert', 'unstage'] as const)('rejects a changed working snapshot before %s', async action => {
    await write('a.txt', 'base'); await commit(); await write('a.txt', 'edit');
    if (action === 'unstage') await command(['add', '--', 'a.txt']);
    const review = await readGitReview(root, action === 'unstage' ? 'staged' : 'unstaged');
    await write('a.txt', 'external'); const indexBefore = await fs.readFile(path.join(root, '.git/index'));
    await expect(act(review, 'a.txt', action)).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('external');
  });

  it('does not overwrite another writer’s index lock, accepts neither bad fingerprints nor fake reviews', async () => {
    await write('a.txt', 'new'); const review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    await expect(applyGitAction(review, f.id, 'stage', 'wrong')).rejects.toMatchObject({ code: 'STALE_FILE' });
    await expect(applyGitAction({ ...review }, f.id, 'stage', f.fingerprint)).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
    await write('.git/index.lock', 'other writer');
    await expect(act(review, 'a.txt', 'stage')).rejects.toMatchObject({ code: 'INDEX_LOCKED' });
    expect(await fs.readFile(path.join(root, '.git/index.lock'), 'utf8')).toBe('other writer');
  });

  it('reports staged rename metadata and atomically unstages both paths without moving working files', async () => {
    await write('old name.txt', original); await commit();
    await command(['mv', '--', 'old name.txt', '中文 new.txt']);
    const review = await readGitReview(root, 'staged'), f = file(review, '中文 new.txt');
    expect(f.status).toBe('renamed'); expect(f.oldPath).toBe('old name.txt');
    await expect(act(review, f.path, 'unstage', '0:1:1')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    await act(review, f.path, 'unstage');
    expect((await command(['ls-files', '-z'])).toString()).toBe('old name.txt\0');
    expect(await fs.readFile(path.join(root, f.path), 'utf8')).toBe(original);
    await expect(fs.stat(path.join(root, 'old name.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects conflicts and preserves all index stages byte-for-byte', async () => {
    await write('a.txt', 'base\n'); await commit(); await command(['checkout', '-b', 'side']);
    await write('a.txt', 'side\n'); await commit(); await command(['checkout', 'main']);
    await write('a.txt', 'main\n'); await commit(); await command(['merge', 'side']).catch(() => {});
    const entries = await command(['ls-files', '--stage', '-z']); expect(entries.toString()).toMatch(/ 1\ta.txt/);
    for (const scope of ['unstaged', 'staged'] as const) {
      const review = await readGitReview(root, scope), f = file(review, 'a.txt');
      expect(f.kind).toBe('conflict'); expect(f.actions).toEqual([]);
      await expect(act(review, 'a.txt', scope === 'staged' ? 'unstage' : 'stage')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    }
    expect(await command(['ls-files', '--stage', '-z'])).toEqual(entries);
  });

  it('compares root/ordinary commits and branches via merge-base, not base tip or working files', async () => {
    await write('common.txt', 'common'); await commit();
    const first = (await command(['rev-parse', 'HEAD'])).toString().trim();
    const initial = await readGitReview(root, 'commit', first);
    expect(initial.notice).toContain('Root commit'); expect(file(initial, 'common.txt').before.exists).toBe(false);
    await command(['checkout', '-b', 'base']); await write('base.txt', 'base only'); await commit();
    await command(['checkout', 'main']); await write('main.txt', 'HEAD only'); await commit();
    await write('main.txt', 'unreviewed working edit');
    const branch = await readGitReview(root, 'branch', 'base');
    expect(branch.files.map(f => f.path)).toEqual(['main.txt']); expect(branch.notice).toContain('merge-base');
    expect(file(branch, 'main.txt').after.text).toBe('HEAD only'); expect(file(branch, 'main.txt').actions).toEqual([]);
    const current = await readGitReview(root, 'commit', 'HEAD');
    expect(current.files.map(f => f.path)).toEqual(['main.txt']); expect(current.notice).toContain('its parent');
    await expect(readGitReview(root, 'commit', '--output=oops')).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(readGitReview(root, 'branch', 'HEAD..base')).rejects.toMatchObject({ code: 'INVALID_REF' });
  });

  it('explicitly compares a merge commit with only its first parent', async () => {
    await write('common.txt', 'common'); await commit(); await command(['checkout', '-b', 'side']);
    await write('side.txt', 'side'); await commit(); await command(['checkout', 'main']);
    await write('main.txt', 'main'); await commit(); await command(['merge', '--no-ff', '-m', 'fixture merge', 'side']);
    const review = await readGitReview(root, 'commit', 'HEAD');
    expect(review.notice).toContain('first parent'); expect(review.files.map(f => f.path)).toEqual(['side.txt']);
  });

  it('omits credential/internal paths in both index and working reviews before reading content', async () => {
    for (const rel of ['.env.local', '.ssh/id_ed25519', '.git-credentials', 'private.pem', 'node_modules/pkg/a.js', '.pi-desktop/log'])
      await write(rel, 'secret');
    await write('public.txt', 'public');
    let review = await readGitReview(root, 'unstaged');
    expect(review.files.map(f => f.path)).toEqual(['public.txt']); expect(review.notice).toContain('omitted');
    await command(['add', '--all', '--']); review = await readGitReview(root, 'staged');
    expect(review.files.map(f => f.path)).toEqual(['public.txt']); expect(review.notice).toContain('omitted');
  });

  it('omits image paths from Git reviews while retaining binary data and non-image rename destinations', async () => {
    await write('old.PNG', 'image base'); await write('vector.SVG', '<svg>base</svg>');
    await write('opaque.dat', Buffer.from([0, 255, 1])); await write('notes.txt', 'notes');
    await write('rename-source.PNG', 'image rename source'); await write('rename-source.txt', 'text rename source'); await commit();
    await write('old.PNG', 'changed image'); await write('vector.SVG', '<svg>changed</svg>');
    await write('opaque.dat', Buffer.from([0, 255, 2])); await write('notes.txt', 'notes changed');
    let review = await readGitReview(root, 'unstaged');
    expect(review.files.map(f => f.path).sort()).toEqual(['notes.txt', 'opaque.dat']);
    expect(file(review, 'opaque.dat').kind).toBe('binary');
    expect((await command(['status', '--short'])).toString()).toContain('old.PNG');
    await command(['add', '--all', '--']); review = await readGitReview(root, 'staged');
    expect(review.files.map(f => f.path).sort()).toEqual(['notes.txt', 'opaque.dat']);
    await command(['mv', '--', 'rename-source.PNG', 'renamed.txt']);
    await command(['mv', '--', 'rename-source.txt', 'renamed.PNG']);
    review = await readGitReview(root, 'staged');
    expect(file(review, 'renamed.txt').oldPath).toBe('rename-source.PNG');
    expect(review.files.some(f => f.path === 'renamed.PNG')).toBe(false);
    const tracked = (await command(['ls-files', '-z'])).toString();
    expect(tracked).toContain('renamed.txt\0'); expect(tracked).toContain('renamed.PNG\0');
  });
  it('keeps symlinks, submodules, binary/large and mode-only changes read-only', async () => {
    await write('normal.txt', 'normal'); await commit();
    await write('binary.bin', Buffer.from([1, 0, 255])); await write('large.txt', Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
    await write('link.txt', 'target.txt');
    await command(['add', '--', 'link.txt']);
    const linkOid = (await command(['rev-parse', ':link.txt'])).toString().trim();
    await command(['update-index', '--cacheinfo', '120000', linkOid, 'link.txt']);
    await command(['update-index', '--chmod=+x', '--', 'normal.txt']);
    const head = (await command(['rev-parse', 'HEAD'])).toString().trim();
    await fs.mkdir(path.join(root, 'module')); await command(['update-index', '--add', '--cacheinfo', '160000', head, 'module']);
    const staged = await readGitReview(root, 'staged');
    expect(file(staged, 'link.txt').kind).toBe('symlink'); expect(file(staged, 'module').kind).toBe('submodule');
    expect(file(staged, 'normal.txt').status).toBe('mode');
    for (const f of staged.files) expect(f.actions).toEqual([]);
    const working = await readGitReview(root, 'unstaged');
    expect(file(working, 'binary.bin').kind).toBe('binary'); expect(file(working, 'large.txt').kind).toBe('large');
    expect(file(working, 'binary.bin').actions).toEqual([]); expect(file(working, 'large.txt').actions).toEqual([]);
    await fs.symlink(container, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const safe = await readGitReview(root, 'unstaged');
    expect(safe.files.some(f => f.path.startsWith('escape/'))).toBe(false);
  });

  it('never executes configured clean/process filters, external diff, textconv, fsmonitor or index hooks', async () => {
    await write('a.txt', 'base'); await commit();
    await write('.gitattributes', 'a.txt filter=evil diff=evil\n');
    await write('evil.sh', '#!/bin/sh\nprintf executed >> sentinel\ncat\n');
    await command(['config', 'filter.evil.clean', 'sh evil.sh']); await command(['config', 'filter.evil.process', 'sh evil.sh']);
    await command(['config', 'filter.evil.required', 'true']); await command(['config', 'diff.evil.textconv', 'sh evil.sh']);
    await command(['config', 'diff.external', 'sh evil.sh']); await command(['config', 'core.fsmonitor', 'sh evil.sh']);
    await write('.git/hooks/post-index-change', '#!/bin/sh\nprintf hook >> sentinel\n');
    await fs.chmod(path.join(root, '.git/hooks/post-index-change'), 0o755);
    await write('a.txt', '\ufeffedit\r\n');
    await act(await readGitReview(root, 'unstaged'), 'a.txt', 'stage');
    const review = await readGitReview(root, 'staged'); expect(file(review, 'a.txt').after.text).toBe('\ufeffedit\r\n');
    await act(review, 'a.txt', 'unstage');
    await expect(fs.stat(path.join(root, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the actual linked-worktree index, not .git/index or the enclosing main worktree', async () => {
    await write('a.txt', 'base'); await commit();
    const worktree = path.join(container, 'linked'); await command(['worktree', 'add', '-b', 'linked', worktree]);
    await write('a.txt', 'linked edit', worktree);
    const mainIndex = await fs.readFile(path.join(root, '.git/index'));
    expect((await discoverRepository(worktree)).git).toBe(true);
    const review = await readGitReview(worktree, 'unstaged'); await act(review, 'a.txt', 'stage');
    expect(await indexed('a.txt', worktree)).toBe('linked edit'); expect(await indexed('a.txt')).toBe('base');
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(mainIndex);
  });

  it('preserves split-index entries and materializes a valid replacement index', async () => {
    await write('a.txt', 'base'); await write('b.txt', 'keep'); await commit();
    await command(['update-index', '--split-index']); await write('a.txt', 'edit');
    await act(await readGitReview(root, 'unstaged'), 'a.txt', 'stage');
    expect(await indexed('a.txt')).toBe('edit'); expect(await indexed('b.txt')).toBe('keep');
  });

  it('enforces subprocess output bounds and a changed-file limit', async () => {
    await expect(boundedGit(root, ['rev-parse', '--git-dir'], { limit: 1 })).rejects.toMatchObject({ code: 'GIT_LIMIT' });
    for (let i = 0; i < 1001; i++) await write(`many/${i}.txt`, 'x');
    await expect(readGitReview(root, 'staged')).resolves.toMatchObject({ files: [] });
    // Changed-file accumulation is capped, including untracked files.
    await expect(readGitReview(root, 'unstaged')).rejects.toMatchObject({ code: 'GIT_LIMIT' });
  });

  it('preserves missing EOF newlines through hunk stage, unstage and revert', async () => {
    const before = original.trimEnd();
    const after = before.replace('line 2\n', 'first changed\n').replace('line 30', 'last changed');
    await write('a.txt', before); await commit(); await write('a.txt', after);
    let review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    let hunks = buildHunks(f.before.text!, f.after.text!); expect(hunks).toHaveLength(2);
    await act(review, 'a.txt', 'stage', hunks[1].id);
    expect(await indexed('a.txt')).toBe(before.replace('line 30', 'last changed'));
    review = await readGitReview(root, 'staged'); f = file(review, 'a.txt');
    await act(review, 'a.txt', 'unstage', buildHunks(f.before.text!, f.after.text!)[0].id);
    expect(await indexed('a.txt')).toBe(before);
    review = await readGitReview(root, 'unstaged'); f = file(review, 'a.txt');
    hunks = buildHunks(f.before.text!, f.after.text!);
    await act(review, 'a.txt', 'revert', hunks[1].id);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(before.replace('line 2\n', 'first changed\n'));
  });

  it('stages and unstages file creation/deletion hunks on an unborn HEAD', async () => {
    await write('a.txt', 'new\n');
    let review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    await act(review, 'a.txt', 'stage', buildHunks('', f.after.text!)[0].id);
    expect(await indexed('a.txt')).toBe('new\n');
    review = await readGitReview(root, 'staged'); f = file(review, 'a.txt');
    await act(review, 'a.txt', 'unstage', buildHunks('', f.after.text!)[0].id);
    expect((await command(['ls-files', '-z'])).length).toBe(0);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new\n');
  });

  it('supports SHA-256 repositories with literal object and index hashes', async () => {
    await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
    await command(['init', '-b', 'main', '--object-format=sha256']);
    await write('a.txt', 'new'); await act(await readGitReview(root, 'unstaged'), 'a.txt', 'stage');
    expect((await command(['rev-parse', ':a.txt'])).toString().trim()).toHaveLength(64);
    await act(await readGitReview(root, 'staged'), 'a.txt', 'unstage');
    expect((await command(['ls-files', '-z'])).length).toBe(0);
  });

  it('bounds retained review bytes and makes budget-exhausted files non-actionable', async () => {
    for (let i = 0; i < 9; i++) await write(`big-${i}.txt`, Buffer.alloc(MAX_TEXT_BYTES - 1, 65));
    const review = await readGitReview(root, 'unstaged');
    expect(review.files).toHaveLength(9);
    const last = file(review, 'big-8.txt'); expect(last.kind).toBe('unavailable');
    expect(last.after.text).toBeNull(); expect(last.actions).toEqual([]);
    expect(review.files.reduce((size, f) => size + Buffer.byteLength(f.after.text ?? ''), 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    await expect(act(review, last.path, 'stage')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
  });

  it('pairs exact-byte unstaged moves and stages both index paths in one transaction', async () => {
    await write('old.txt', 'exact move'); await write('keep.txt', 'keep'); await commit();
    await fs.rename(path.join(root, 'old.txt'), path.join(root, '中文 new.txt'));
    const review = await readGitReview(root, 'unstaged'), f = file(review, '中文 new.txt');
    expect(review.files).toHaveLength(1); expect(f.status).toBe('renamed'); expect(f.oldPath).toBe('old.txt');
    expect(f.actions).toEqual(['stage']);
    await expect(act(review, f.path, 'revert')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    await act(review, f.path, 'stage');
    expect((await command(['ls-files', '-z'])).toString()).not.toContain('old.txt\0');
    expect(await indexed(f.path)).toBe('exact move'); expect(await indexed('keep.txt')).toBe('keep');
    expect(await fs.readFile(path.join(root, f.path), 'utf8')).toBe('exact move');
  });

  it('does not hide a symlink-to-regular-file type change when core.filemode is false', async () => {
    await write('a.txt', 'target'); await command(['add', '--', 'a.txt']);
    const oid = (await command(['rev-parse', ':a.txt'])).toString().trim();
    await command(['update-index', '--cacheinfo', '120000', oid, 'a.txt']);
    await command(['config', 'core.filemode', 'false']);
    const review = await readGitReview(root, 'unstaged'), f = file(review, 'a.txt');
    expect(f.kind).toBe('symlink'); expect(f.actions).toEqual([]);
  });
});
