import { it, expect, vi, afterEach } from 'vitest';
import { boundedTransport } from '../../src/view/transport';
import { prefetchDiffDetail } from '../../src/view/useDiffDetail';
import type { ReviewDetail, UiTransport } from '../../src/core/contracts';

afterEach(() => vi.useRealTimers());
it('returns fast job results without polling and keeps a six-request rolling burst bound', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  const invoke = vi.fn(async (method: string) => method === 'jobStart' ? { jobId: 'job', state: 'done', result: { ok: true } } : { ok: true });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  expect(await transport.invoke('review', {})).toEqual({ ok: true });
  expect(invoke).toHaveBeenCalledTimes(1); expect(invoke.mock.calls[0][0]).toBe('jobStart');
  for (let i = 0; i < 5; i++) await transport.invoke('file', {});
  const pending = transport.invoke('file', {}); await vi.advanceTimersByTimeAsync(999);
  expect(invoke).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(3); await pending;
  expect(invoke).toHaveBeenCalledTimes(7);
});
it('deduplicates pending prefetches and isolates cache by transport', async () => {
  const detail: ReviewDetail = { file: { id: 'f', path: 'f.txt', status: 'modified', kind: 'text', additions: 1, deletions: 1, fingerprint: 'v1', actions: [] }, offset: 0, nextOffset: null, hunks: [], totalRows: 0 };
  let resolve!: (page: ReviewDetail) => void;
  const first = { invoke: vi.fn(() => new Promise<ReviewDetail>(done => { resolve = done; })) } as unknown as UiTransport;
  const second = { invoke: vi.fn(async () => detail) } as unknown as UiTransport;
  prefetchDiffDetail(first, 'r', 'f'); prefetchDiffDetail(first, 'r', 'f'); prefetchDiffDetail(second, 'r', 'f');
  for (let i = 0; i < 30; i++) prefetchDiffDetail(first, 'r', `hover-${i}`);
  expect(first.invoke).toHaveBeenCalledTimes(1);
  expect(first.invoke).toHaveBeenCalledTimes(1); expect(second.invoke).toHaveBeenCalledTimes(1);
  resolve(detail); await new Promise(done => setTimeout(done, 0));
  prefetchDiffDetail(first, 'r', 'f'); expect(first.invoke).toHaveBeenCalledTimes(1);
});
