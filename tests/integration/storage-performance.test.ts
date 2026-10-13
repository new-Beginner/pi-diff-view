import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotStore, MAX_HISTORY_BYTES } from '../../src/core/storage';
import { digest } from '../../src/core/path-policy';
import type { CaptureRun, FileSnapshot } from '../../src/core/contracts';

let temp: string, store: SnapshotStore;
const run = (id: string): CaptureRun => ({ version: 1, id, sessionId: 's', root: path.resolve(temp), generation: 'test-generation-123456789', startedAt: 1, state: 'completed', fileCount: 1, incomplete: false, changes: { 'a.txt': { before: { exists: false, text: null, hash: '', size: 0, mode: 0, kind: 'text' }, after: { exists: false, text: null, hash: '', size: 0, mode: 0, kind: 'text' } } }, replies: [], bindings: {} });
beforeEach(async () => { temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'storage-perf-')); store = new SnapshotStore(path.join(temp, 'store')); await store.init(); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

describe('storage bounded I/O', () => {
  it('resolves chained aliases with one read per scan and sees external alias updates on the next scan', async () => {
    const runs = path.join(store.directory, 'runs'), aliasesFile = path.join(store.directory, 'run-aliases.json');
    await fs.writeFile(path.join(runs, 'legacy.json'), JSON.stringify(run('canonical')));
    await fs.writeFile(path.join(runs, 'canonical.json'), JSON.stringify(run('canonical')));
    await fs.writeFile(path.join(runs, 'other.json'), JSON.stringify(run('other')));
    await fs.writeFile(aliasesFile, JSON.stringify({ legacy: 'middle', middle: 'canonical' }));
    const readFile = vi.spyOn(fs, 'readFile');
    const first = await store.listRuns(false, true);
    expect(first.map(item => item.id)).toEqual(['canonical', 'other']);
    expect(readFile.mock.calls.filter(([file]) => String(file) === aliasesFile)).toHaveLength(1);

    await fs.writeFile(aliasesFile, JSON.stringify({ legacy: 'other' }));
    const second = await store.listRuns(false, true);
    expect(second.map(item => item.id)).toEqual(['canonical', 'other']);
    expect(readFile.mock.calls.filter(([file]) => String(file) === aliasesFile)).toHaveLength(2);
    await fs.writeFile(aliasesFile, '{broken');
    expect(await store.listRuns(false, true)).toEqual([]);
    expect(readFile.mock.calls.filter(([file]) => String(file) === aliasesFile)).toHaveLength(3);
  });

  it('limits quota stats to 16 concurrent calls and rechecks external blob changes after rejection', async () => {
    const blobs = path.join(store.directory, 'blobs');
    for (let i = 0; i < 17; i++) await fs.writeFile(path.join(blobs, `external-${i}`), 'x');
    const original = fs.stat.bind(fs);
    let active = 0, maximum = 0;
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file: Parameters<typeof fs.stat>[0], ...args: any[]) => {
      if (String(file).startsWith(`${blobs}${path.sep}`)) {
        active++; maximum = Math.max(maximum, active);
        try { await new Promise(resolve => setTimeout(resolve, 4)); return await original(file, ...args as [any]); }
        finally { active--; }
      }
      return original(file, ...args as [any]);
    });
    const snapshot: FileSnapshot = { exists: true, kind: 'text', text: 'x', hash: digest('x'), size: MAX_HISTORY_BYTES, mode: 0 };
    await expect(store.saveBlob(snapshot)).rejects.toThrow('128 MiB snapshot capacity reached');
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(16);
    expect(stat.mock.calls.filter(([file]) => String(file).startsWith(`${blobs}${path.sep}`))).toHaveLength(18); // 17 quota entries plus the destination existence check

    stat.mockRestore();
    for (let i = 0; i < 17; i++) await fs.unlink(path.join(blobs, `external-${i}`));
    expect((await store.saveBlob(snapshot)).text).toBeNull();
    expect(await fs.readFile(path.join(blobs, snapshot.hash), 'utf8')).toBe('x');
  });
});
