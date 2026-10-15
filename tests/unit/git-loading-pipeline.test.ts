import { afterEach, expect, it, vi } from 'vitest';
import { JobQueue } from '../../src/core/jobs';
import { ReadWriteQueue } from '../../src/core/read-write-queue';
import { boundedTransport } from '../../src/view/transport';
import type { UiTransport } from '../../src/core/contracts';

afterEach(() => vi.useRealTimers());
function clock() {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const queue = (globalThis as any).__piDiffBurstQueue;
  Object.assign(queue, { starts: [], tail: Promise.resolve(), navigationTail: Promise.resolve(), gitTail: Promise.resolve(), mutationTail: Promise.resolve() });
}
it('Git reads bypass a slow ordinary job instead of joining its global tail', async () => {
  clock(); let release!: () => void;
  const calls: string[] = [];
  const jobs = new JobQueue(async method => {
    calls.push(method);
    if (method === 'review') await new Promise<void>(resolve => { release = resolve; });
    return method;
  });
  const review = jobs.start('review', {}); await vi.advanceTimersByTimeAsync(2);
  const git = jobs.start('gitManage', { operation: 'history' }); await vi.advanceTimersByTimeAsync(2);
  const observed = [...calls], state = jobs.poll(git.jobId).state;
  release(); await vi.advanceTimersByTimeAsync(5);
  expect(jobs.poll(review.jobId).state).toBe('done'); jobs.close();
  expect(observed).toEqual(['review', 'gitManage']); expect(state).toBe('done');
});
it('two 200ms Git reads complete below 600ms through real jobs and bounded polling', async () => {
  clock(); const admissions: number[] = [], repository = new ReadWriteQueue(4);
  const jobs = new JobQueue((_method, _args) => repository.run(async () => {
    await new Promise(resolve => setTimeout(resolve, 200)); return { ok: true };
  }));
  const wire: UiTransport['invoke'] = async <T,>(method: string, value?: unknown): Promise<T> => {
    admissions.push(Date.now()); const args = value as any;
    if (method === 'jobStart') {
      const started = jobs.start(args.method, args.args), result = await jobs.wait(started.jobId, args.waitMs);
      return (result.state === 'pending' ? started : { ...started, ...result }) as T;
    }
    return jobs.poll(args.jobId) as T;
  };
  const transport = boundedTransport(wire); let completed = 0;
  const pending = Promise.all(['status', 'history'].map(operation => transport.invoke('gitManage', { operation }).then(() => { completed++; })));
  await vi.advanceTimersByTimeAsync(600); const completedAt600 = completed;
  await vi.advanceTimersByTimeAsync(1500); await pending; jobs.close();
  expect(completedAt600).toBe(2);
  for (const at of admissions) expect(admissions.filter(time => time >= at && time < at + 1000).length).toBeLessThanOrEqual(6);
});
it('Git job bypass retains the repository read/write fence and error recovery', async () => {
  clock(); const queue = new ReadWriteQueue(4), calls: string[] = [];
  let releaseRead!: () => void, releaseWrite!: () => void;
  const jobs = new JobQueue((_method, value) => {
    const { operation } = value as { operation: string };
    return queue.run(async () => {
      calls.push(operation);
      if (operation === 'history') await new Promise<void>(resolve => { releaseRead = resolve; });
      if (operation === 'commit') { await new Promise<void>(resolve => { releaseWrite = resolve; }); throw new Error('hook refused'); }
      return operation;
    }, operation === 'commit');
  });
  jobs.start('gitManage', { operation: 'history' }); await vi.advanceTimersByTimeAsync(2);
  const write = jobs.start('gitManage', { operation: 'commit' });
  const after = jobs.start('gitManage', { operation: 'branches' }); await vi.advanceTimersByTimeAsync(2);
  expect(calls).toEqual(['history']);
  releaseRead(); await vi.advanceTimersByTimeAsync(2); expect(calls).toEqual(['history', 'commit']);
  releaseWrite(); await vi.advanceTimersByTimeAsync(2);
  expect(calls).toEqual(['history', 'commit', 'branches']);
  expect(jobs.poll(write.jobId).state).toBe('error'); expect(jobs.poll(after.jobId).result).toBe('branches'); jobs.close();
});
