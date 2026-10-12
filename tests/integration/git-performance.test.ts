import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { readGitReview } from '../../src/git/repository';
import { applyGitAction } from '../../src/git/actions';
import { git, OUTPUT_LIMIT, readGitBlobs } from '../../src/git/runner';
import { MAX_TEXT_BYTES } from '../../src/core/contracts';
import { digest } from '../../src/core/path-policy';

// Count actual subprocesses, not mocked Git responses.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
let root: string;
const command = (args: string[], input?: Buffer) => git(root, [
  '-c', 'user.name=Performance Test', '-c', 'user.email=performance@example.invalid',
  '-c', 'core.autocrlf=false', ...args,
], { input });
const write = (rel: string, bytes: string | Buffer) => fs.writeFile(path.join(root, rel), bytes);
async function writeMany(names: string[], content: (name: string) => string) {
  for (let start = 0; start < names.length; start += 64)
    await Promise.all(names.slice(start, start + 64).map(name => write(name, content(name))));
}
async function store(bytes: Buffer): Promise<string> {
  return (await command(['hash-object', '--no-filters', '-w', '--stdin'], bytes)).stdout.toString().trim();
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-git-performance-'));
  await command(['init', '-b', 'main']);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('real Git bounded batch performance and correctness', () => {
  it('measures 600 changes among 2000 tracked files without filters or per-blob processes', async () => {
    const changed = Array.from({ length: 600 }, (_, i) => `changed-${i}.txt`);
    const clean = Array.from({ length: 1400 }, (_, i) => `clean-${i}.txt`);
    const before = (name: string) => `\ufeff${name} 原始\r\nlast`;
    const staged = (name: string) => `\ufeff${name} 暂存\r\nlast`;
    const working = (name: string) => `\ufeff${name} 工作\r\nlast`;
    await writeMany([...changed, ...clean], before);
    await command(['add', '--all', '--']); await command(['commit', '-m', 'base']);
    await writeMany(changed, staged);
    await write('二进制.bin', Buffer.from([0, 10, 255, 13, 128]));
    await write('large.txt', Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
    await command(['add', '--all', '--']);
    // Install hostile configuration only AFTER fixture creation. Review must never run it.
    await write('.gitattributes', '*.txt filter=evil diff=evil\n');
    const evil = 'echo executed >> sentinel; exit 1';
    for (const key of ['filter.evil.clean', 'filter.evil.process', 'diff.evil.textconv', 'diff.external', 'core.fsmonitor'])
      await command(['config', key, evil]);
    await command(['config', 'filter.evil.required', 'true']);
    const indexBefore = await fs.readFile(path.join(root, '.git/index'));
    for (const scope of ['staged', 'unstaged'] as const) {
      if (scope === 'unstaged') await writeMany(changed, working);
      vi.mocked(spawn).mockClear();
      const start = performance.now();
      const review = await readGitReview(root, scope);
      const elapsed = performance.now() - start;
      const calls = vi.mocked(spawn).mock.calls.map(call => call[1] as string[]);
      const objectCalls = calls.filter(args => args.includes('cat-file'));
      console.info(`[git-performance] ${scope}: 2000 tracked, 600 edited, ${elapsed.toFixed(1)}ms, ${calls.length} Git processes (${objectCalls.length} object batches)`);
      expect(objectCalls).toHaveLength(2);
      expect(objectCalls.some(args => args.includes('--batch-check'))).toBe(true);
      expect(objectCalls.some(args => args.includes('--batch'))).toBe(true);
      const byPath = new Map(review.files.map(file => [file.path, file]));
      for (const name of changed) {
        expect(byPath.get(name)?.before.text).toBe(scope === 'staged' ? before(name) : staged(name));
        expect(byPath.get(name)?.after.text).toBe(scope === 'staged' ? staged(name) : working(name));
      }
      expect(review.files.some(file => file.path.startsWith('clean-'))).toBe(false);
      expect(byPath.get('large.txt')?.kind).toBe('large');
      expect(byPath.get('large.txt')?.actions).toEqual([]);
      if (scope === 'staged') {
        expect(byPath.get('二进制.bin')?.kind).toBe('binary');
        expect(byPath.get('二进制.bin')?.after.hash).toBe(digest(Buffer.from([0, 10, 255, 13, 128])));
        expect(byPath.get('二进制.bin')?.actions).toEqual([]);
      }
      if (scope === 'unstaged') {
        const file = byPath.get(changed[0])!;
        await write(file.path, 'changed after review');
        await expect(applyGitAction(review, file.id, 'stage', file.fingerprint)).rejects.toMatchObject({ code: 'FILE_CHANGED' });
      }
    }
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
    await expect(fs.stat(path.join(root, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);

  it('parses binary byte lengths, empty objects, duplicate OIDs and large-object metadata', async () => {
    const binary = Buffer.concat([Buffer.from([0, 255, 10]), Buffer.from(`${'a'.repeat(40)} blob 4\nbody\n`), Buffer.from([128])]);
    const text = Buffer.from('\ufeff你好\r\nno final newline');
    const large = Buffer.alloc(MAX_TEXT_BYTES + 1, 65);
    const oids = await Promise.all([binary, text, Buffer.alloc(0), large].map(store));
    vi.mocked(spawn).mockClear();
    const values = await readGitBlobs(root, [...oids, oids[0]], {
      budget: OUTPUT_LIMIT, maxSize: MAX_TEXT_BYTES, deadline: Date.now() + 30000,
    });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(values.size).toBe(4);
    expect(values.get(oids[0])?.bytes).toEqual(binary);
    expect(values.get(oids[1])?.bytes).toEqual(text);
    expect(values.get(oids[2])?.bytes).toEqual(Buffer.alloc(0));
    expect(values.get(oids[3])).toEqual({ size: large.length });
    const limited = await readGitBlobs(root, oids, { budget: text.length, maxSize: MAX_TEXT_BYTES, deadline: Date.now() + 30000 });
    expect(limited.get(oids[0])?.bytes).toBeUndefined();
    expect(limited.get(oids[1])?.bytes).toEqual(text);
    expect([...limited.values()].reduce((sum, blob) => sum + (blob.bytes?.length ?? 0), 0)).toBeLessThanOrEqual(text.length);
    await expect(readGitBlobs(root, [oids[0]], { budget: OUTPUT_LIMIT, maxSize: MAX_TEXT_BYTES, deadline: Date.now() - 1 }))
      .rejects.toMatchObject({ code: 'GIT_TIMEOUT' });
    await expect(readGitBlobs(root, ['f'.repeat(40)], { budget: OUTPUT_LIMIT, maxSize: MAX_TEXT_BYTES, deadline: Date.now() + 30000 }))
      .rejects.toMatchObject({ code: 'GIT_FAILED' });
  });

  it('keeps total batch payload and framing below OUTPUT_LIMIT', async () => {
    const oids: string[] = [];
    for (let i = 0; i < 9; i++) oids.push(await store(Buffer.alloc(MAX_TEXT_BYTES, 65 + i)));
    const values = await readGitBlobs(root, oids, { budget: OUTPUT_LIMIT, maxSize: MAX_TEXT_BYTES, deadline: Date.now() + 30000 });
    const loaded = [...values.values()].filter(blob => blob.bytes);
    expect(loaded).toHaveLength(7); // Eight payloads alone fill the limit, leaving no room for headers.
    expect(loaded.reduce((sum, blob) => sum + blob.bytes!.length, 0)).toBeLessThan(OUTPUT_LIMIT);
    expect([...values.values()].every(blob => blob.size === MAX_TEXT_BYTES)).toBe(true);
  });
  it('charges repeated object snapshots against the retained review budget', async () => {
    const oid = await store(Buffer.alloc(MAX_TEXT_BYTES - 1, 65));
    const rows = Array.from({ length: 9 }, (_, i) => `100644 ${oid}\tduplicate-${i}.txt\0`).join('');
    await command(['update-index', '-z', '--index-info'], Buffer.from(rows));
    const review = await readGitReview(root, 'staged');
    expect(review.files).toHaveLength(9);
    expect(review.files[8].kind).toBe('unavailable');
    expect(review.files[8].actions).toEqual([]);
    expect(review.files.reduce((sum, file) => sum + Buffer.byteLength(file.before.text ?? '') + Buffer.byteLength(file.after.text ?? ''), 0))
      .toBeLessThanOrEqual(OUTPUT_LIMIT);
  });


  it('refunds concurrent clean binary reads and observes new working bytes on every review', async () => {
    const bytes = Buffer.alloc(MAX_TEXT_BYTES - 1, 0);
    for (let i = 0; i < 12; i++) await write(`binary-${i}.bin`, bytes);
    await command(['add', '--all', '--']);
    vi.mocked(spawn).mockClear();
    expect((await readGitReview(root, 'unstaged')).files).toEqual([]);
    expect(vi.mocked(spawn).mock.calls.some(call => (call[1] as string[]).includes('cat-file'))).toBe(false);
    await write('binary-0.bin', 'now text');
    let review = await readGitReview(root, 'unstaged');
    expect(review.files).toHaveLength(1);
    expect(review.files[0].before.kind).toBe('binary');
    expect(review.files[0].after.text).toBe('now text');
    await write('binary-0.bin', 'new text');
    review = await readGitReview(root, 'unstaged');
    expect(review.files[0].after.text).toBe('new text');
  });

  it('omits tracked paths whose ancestor becomes a symlink or junction before batch loading', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    await write('nested/file.txt', 'tracked');
    await command(['add', '--all', '--']);
    await fs.mkdir(path.join(root, '.git/private'));
    await write('.git/private/file.txt', 'never expose');
    await fs.rm(path.join(root, 'nested'), { recursive: true });
    await fs.symlink(path.join(root, '.git/private'), path.join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    vi.mocked(spawn).mockClear();
    const review = await readGitReview(root, 'staged');
    expect(review.files).toEqual([]);
    expect(review.notice).toContain('omitted');
    expect(vi.mocked(spawn).mock.calls.some(call => (call[1] as string[]).includes('cat-file'))).toBe(false);
  });
});
