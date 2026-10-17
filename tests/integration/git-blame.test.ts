import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch, type ManagementArgs, type ManagementBlame } from '../../src/git/local-management';

const exec = promisify(execFile);
let root: string;
const command = async (...args: string[]) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, windowsHide: true })).stdout.trim();
};
const read = (args: Partial<ManagementArgs> = {}) => dispatch('gitManage', { operation: 'blame', root, path: '文件 name.txt', ...args }, [root]) as Promise<ManagementBlame>;
const save = async (content: string | Buffer, file = '文件 name.txt') => fs.writeFile(path.join(root, file), content);
const commit = async (message: string) => { await command('add', '.'); await command('commit', '-m', message); return command('rev-parse', 'HEAD'); };
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw Error('Scratch required');
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'git-blame-'));
  await command('init', '-b', 'main'); await command('config', 'user.name', '追溯测试 Author'); await command('config', 'user.email', 'blame@example.test');
  await command('config', 'core.autocrlf', 'false');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('returns distinct commit metadata, exact line numbers and committed code without modifying worktree/index', async () => {
  await save('首行\n\tkeep\n\nlast'); const first = await commit('首次提交');
  await save('首行\n\tchanged\n\nlast'); const second = await commit('修改第二行');
  await save('uncommitted'); const status = await command('status', '--porcelain'); const index = await fs.readFile(path.join(root, '.git/index'));
  const data = await read();
  expect(data).toMatchObject({ oid: second, totalLines: 4, skip: 0, hasMore: false });
  expect(data.lines.map(line => [line.line, line.originalLine, line.oid, line.text])).toEqual([[1, 1, first, '首行'], [2, 2, second, '\tchanged'], [3, 3, first, ''], [4, 4, first, 'last']]);
  expect(data.commits).toEqual(expect.arrayContaining([expect.objectContaining({ oid: first, author: '追溯测试 Author', subject: '首次提交' }), expect.objectContaining({ oid: second, subject: '修改第二行' })]));
  expect(data.commits.every(item => !Number.isNaN(Date.parse(item.date)))).toBe(true);
  expect(await command('status', '--porcelain')).toBe(status); expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(index);
  expect(await fs.readFile(path.join(root, '文件 name.txt'), 'utf8')).toBe('uncommitted');
});

it('paginates a pinned revision after HEAD changes and ignores current file deletion', async () => {
  await save(Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n')); const oid = await commit('many lines');
  const first = await read(); expect(first.lines).toHaveLength(100); expect(first.hasMore).toBe(true);
  await save('new head\n'); await commit('replace'); await fs.unlink(path.join(root, '文件 name.txt'));
  const next = await read({ ref: oid, skip: 100 }); expect(next.lines[0]).toMatchObject({ line: 101, text: 'line 101' });
  const last = await read({ ref: oid, skip: 200 }); expect(last.lines).toHaveLength(5); expect(last.hasMore).toBe(false);
  for (const args of [{ skip: -1 }, { limit: 201 }, { skip: 0.5 }, { skip: 205, ref: oid }]) await expect(read(args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});

it('handles empty files and rejects missing, sensitive, traversal, directory, binary and oversized files', async () => {
  await save(''); await save(Buffer.from([0, 1, 2]), 'binary.dat'); await save('x'.repeat(1024 * 1024 + 1), 'large.txt'); await save('secret', '.env');
  await fs.mkdir(path.join(root, 'dir')); await save('nested', 'dir/child.txt'); await commit('file kinds');
  expect(await read()).toMatchObject({ totalLines: 0, lines: [], commits: [], hasMore: false });
  for (const file of ['missing.txt', 'dir']) await expect(read({ path: file })).rejects.toMatchObject({ code: 'NOT_FILE' });
  await expect(read({ path: 'binary.dat' })).rejects.toMatchObject({ code: 'BINARY_FILE' });
  await expect(read({ path: 'large.txt' })).rejects.toMatchObject({ code: 'GIT_LIMIT' });
  await expect(read({ path: '../outside' })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(read({ path: '.env' })).rejects.toThrow();
});

it('keeps JSON pages below bridge limits and explicitly marks clipped long lines', async () => {
  await save(Array.from({ length: 40 }, () => '中'.repeat(5000)).join('\n')); await commit('long lines');
  let skip = 0;
  do {
    const data = await read({ skip });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(48000);
    expect(data.lines.length).toBeGreaterThan(0); expect(data.lines.every(line => line.truncated && line.text.length === 4000)).toBe(true);
    expect(data.lines[0].line).toBe(skip + 1); skip += data.lines.length;
    if (!data.hasMore) break;
  } while (skip < 40);
  expect(skip).toBe(40);
});
