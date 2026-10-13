import { expect, it, vi } from 'vitest';
import { ReadWriteQueue } from '../../src/core/read-write-queue';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it('reads overlap but writes fence preceding reads and following operations', async () => {
  const queue = new ReadWriteQueue(2), first = deferred(), write = deferred(), events: string[] = [];
  const a = queue.run(async () => { events.push('a'); await first.promise; });
  const b = queue.run(async () => { events.push('b'); });
  const c = queue.run(async () => { events.push('write'); await write.promise; }, true);
  const d = queue.run(async () => { events.push('after'); });
  await flush(); expect(events).toEqual(['a', 'b']);
  first.resolve(); await Promise.all([a, b]); await flush(); expect(events).toEqual(['a', 'b', 'write']);
  write.resolve(); await Promise.all([c, d]); expect(events).toEqual(['a', 'b', 'write', 'after']); expect(queue.pending).toBe(0);
});
it('bounds read concurrency and recovers after reader and writer failures', async () => {
  const queue = new ReadWriteQueue(3), gate = deferred(); let active = 0, peak = 0;
  const reads = Array.from({ length: 10 }, () => queue.run(async () => { peak = Math.max(peak, ++active); await gate.promise; active--; }));
  await flush(); expect(active).toBe(3); gate.resolve(); await Promise.all(reads); expect(peak).toBe(3);
  await expect(queue.run(async () => { throw new Error('read'); })).rejects.toThrow('read');
  await expect(queue.run(async () => { throw new Error('write'); }, true)).rejects.toThrow('write');
  const work = vi.fn(async () => 'ok'); expect(await queue.run(work)).toBe('ok'); expect(await queue.run(work, true)).toBe('ok'); expect(queue.pending).toBe(0);
});
