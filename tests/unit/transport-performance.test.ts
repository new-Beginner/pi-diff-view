import { it, expect, vi, afterEach } from 'vitest';
import { boundedTransport, invalidateSessionReads } from '../../src/view/transport';
import { prefetchDiffDetail } from '../../src/view/useDiffDetail';
import type { ReviewDetail, UiTransport } from '../../src/core/contracts';
import { JobQueue } from '../../src/core/jobs';

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
it('navigation bypasses an in-flight slow response without blocking ordinary calls', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; queue.navigationTail = Promise.resolve(); await queue.tail;
  let finishSlow!: (value: unknown) => void;
  const invoke = vi.fn((method: string) => method === 'file' ? new Promise(resolve => { finishSlow = resolve; }) : Promise.resolve({ ok: true }));
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const slow = transport.invoke('file'); await vi.advanceTimersByTimeAsync(0);
  const selection = transport.invoke('readTurnSelection', { nonce: 'n', sessionId: 's' }); await vi.advanceTimersByTimeAsync(0);
  await expect(selection).resolves.toEqual({ ok: true });
  const copied = transport.invoke('copyPath'); await vi.advanceTimersByTimeAsync(0);
  await expect(copied).resolves.toEqual({ ok: true });
  finishSlow({ ok: true }); await slow;
});
it('concurrent navigation and ordinary admissions still obey the rolling burst cap', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; queue.navigationTail = Promise.resolve(); await queue.tail;
  const starts: number[] = [], invoke = vi.fn(async () => { starts.push(Date.now()); return { ok: true }; });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const requests = Array.from({ length: 12 }, (_, i) => transport.invoke(i % 2 ? 'readTurnSelection' : 'copyPath'));
  await vi.advanceTimersByTimeAsync(2100); await Promise.all(requests);
  expect(starts).toHaveLength(12);
  for (const at of starts) expect(starts.filter(time => time >= at && time < at + 1000).length).toBeLessThanOrEqual(6);
});
it('target selection start and polls bypass a slow ordinary response while retaining burst limits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; queue.navigationTail = Promise.resolve(); await queue.tail;
  let finishSlow!: (value: unknown) => void;
  const invoke = vi.fn((method: string) => method === 'file' ? new Promise(resolve => finishSlow = resolve) : Promise.resolve(method === 'jobStart' ? { jobId: 'selection' } : method === 'jobPoll' ? { state: 'done', result: { nonce: 'selection' } } : { ok: true }));
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const slow = transport.invoke('file'); await vi.advanceTimersByTimeAsync(0);
  const selection = transport.invoke('selectTurn', { sessionId: 's', runId: 'r' }); await vi.advanceTimersByTimeAsync(100);
  await expect(selection).resolves.toEqual({ nonce: 'selection' });
  expect(invoke.mock.calls.map(([method]) => method)).toEqual(['file', 'jobStart', 'jobPoll']);
  finishSlow({ ok: true }); await slow;
});
it('independent ordinary reads and copying start before a slow detail completes', async () => {
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  let finish!: (value: unknown) => void;
  const invoke = vi.fn((method: string) => method === 'file' ? new Promise(resolve => finish = resolve) : Promise.resolve({ ok: true }));
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const slow = transport.invoke('file'); await vi.advanceTimersByTimeAsync(0);
  const reads = [transport.invoke('reviewFiles'), transport.invoke('comments'), transport.invoke('copyPath')];
  await vi.advanceTimersByTimeAsync(0);
  const methods = invoke.mock.calls.map(([method]) => method);
  finish({ ok: true }); await vi.advanceTimersByTimeAsync(0); await Promise.all([slow, ...reads]);
  expect(methods).toEqual(['file', 'reviewFiles', 'comments', 'copyPath']);
});
it('settings writes remain ordered', async () => {
  vi.useFakeTimers(); vi.setSystemTime(30000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  let finish!: (value: unknown) => void;
  const invoke = vi.fn((_method: string, args: any) => args?.layout === 'split' ? new Promise(resolve => finish = resolve) : Promise.resolve({ ok: true }));
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const first = transport.invoke('settings', { layout: 'split' }); await vi.advanceTimersByTimeAsync(0);
  const second = transport.invoke('settings', { layout: 'unified' }); await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  finish({ ok: true }); await first; await second;
  expect(invoke.mock.calls.map(([, args]) => args.layout)).toEqual(['split', 'unified']);
});
it('long Git jobs do not block comments but fence subsequent repository writes and reads', async () => {
  vi.useFakeTimers(); vi.setSystemTime(40000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  let done = false;
  const invoke = vi.fn(async (method: string, args: any) => method === 'jobStart'
    ? args.args?.operation === 'commit' ? { jobId: 'commit', state: 'pending' } : { jobId: 'other', state: 'done', result: { ok: true } }
    : method === 'jobPoll' ? { state: done ? 'done' : 'pending', result: { ok: true } } : { ok: true });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const commit = transport.invoke('gitManage', { operation: 'commit' }); await vi.advanceTimersByTimeAsync(0);
  const next = transport.invoke('gitManage', { operation: 'stage' });
  const status = transport.invoke('gitManage', { operation: 'status' });
  await expect(transport.invoke('comments')).resolves.toEqual({ ok: true });
  expect(invoke.mock.calls.map(([method]) => method)).toEqual(['jobStart', 'comments']);
  done = true; await vi.advanceTimersByTimeAsync(1100); await Promise.all([commit, next, status]);
  expect(invoke.mock.calls.filter(([method]) => method === 'jobStart').map(([, args]) => args.args.operation)).toEqual(['commit', 'stage', 'status']);
});
it('system-open uses one background start, does not fence copying and never retries launch errors', async () => {
  vi.useFakeTimers(); vi.setSystemTime(50000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; queue.navigationTail = Promise.resolve(); await queue.tail;
  let done = false;
  const invoke = vi.fn(async (method: string) => method === 'jobStart' ? { jobId: 'open' } : method === 'jobPoll'
    ? done ? { state: 'error', error: { code: 'SYSTEM_OPEN_FAILED', message: 'No association' } } : { state: 'pending' } : { ok: true });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const opening = transport.invoke('openSystemFile', { reviewId: 'r', fileId: 'f', sessionId: 's' });
  const check = expect(opening).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED' });
  await vi.advanceTimersByTimeAsync(0);
  await expect(transport.invoke('copyPath')).resolves.toEqual({ ok: true });
  done = true; await vi.advanceTimersByTimeAsync(100); await check;
  expect(invoke.mock.calls.filter(([method]) => method === 'jobStart')).toHaveLength(1);
});
it('saved-card reads bypass an unfinished evidence upload without removing the shared rate limit', async () => {
  vi.useFakeTimers(); vi.setSystemTime(60000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  let uploaded = false;
  const invoke = vi.fn(async (method: string, args: any) => method === 'jobStart'
    ? args.method === 'sessionEvidence' ? { jobId: 'upload' } : { jobId: 'read', state: 'done', result: { ok: true } }
    : method === 'jobPoll' ? { state: uploaded ? 'done' : 'pending', result: { ok: true } } : { ok: true });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const upload = transport.invoke('sessionEvidence', { chunk: 'saved evidence' }); await vi.advanceTimersByTimeAsync(0);
  const reads = [transport.invoke('replyCards', { sessionId: 's' }), transport.invoke('review', { scope: 'turn', sessionId: 's', runId: 'r' }), transport.invoke('file', { reviewId: 'saved:r', fileId: 'f' })];
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke.mock.calls.filter(([method]) => method === 'jobStart').map(([, args]) => args.method)).toEqual(['sessionEvidence', 'replyCards', 'review']);
  expect(invoke.mock.calls.some(([method]) => method === 'file')).toBe(true);
  await Promise.all(reads);
  uploaded = true; await vi.advanceTimersByTimeAsync(1100); await upload;
});
it('waits for unadmitted busy reads, coalesces identical reads and never replays admitted work', async () => {
  vi.useFakeTimers(); vi.setSystemTime(70000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  let admitted = false;
  const invoke = vi.fn(async (method: string) => method === 'jobStart'
    ? admitted ? { jobId: 'read', state: 'done', result: { ok: true } } : { state: 'busy' }
    : { state: 'done', result: { ok: true } });
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const first = transport.invoke('bootstrap', { sessionId: 'a' }), same = transport.invoke('bootstrap', { sessionId: 'a' });
  await vi.advanceTimersByTimeAsync(0); expect(invoke).toHaveBeenCalledTimes(1);
  admitted = true; await vi.advanceTimersByTimeAsync(350);
  await expect(first).resolves.toEqual({ ok: true }); await expect(same).resolves.toEqual({ ok: true });
  expect(invoke.mock.calls.map(([method]) => method)).toEqual(['jobStart', 'jobStart']);
});
it('drains five legitimate reads through the real four-job queue without JOB_BUSY or duplicate execution', async () => {
  vi.useFakeTimers(); vi.setSystemTime(80000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  const releases: (() => void)[] = [], executed: string[] = [];
  const jobs = new JobQueue(async (method, args: any) => {
    executed.push(args.root ?? method);
    if (method === 'gitManage') await new Promise<void>(resolve => releases.push(resolve));
    return { ok: true };
  });
  const starts: number[] = [];
  const transport = boundedTransport(async (method, args: any): Promise<any> => {
    starts.push(Date.now());
    return method === 'jobStart' ? jobs.admit(args.method, args.args, args.queueIfBusy) : jobs.poll(args.jobId);
  });
  try {
    const reads = [...Array.from({ length: 4 }, (_, i) => transport.invoke('gitManage', { operation: 'status', root: `root-${i}` })), transport.invoke('bootstrap', { sessionId: 's' })];
    await vi.advanceTimersByTimeAsync(10); expect(releases).toHaveLength(4); expect(executed).not.toContain('bootstrap');
    releases.forEach(release => release()); await vi.advanceTimersByTimeAsync(4000);
    expect(await Promise.all(reads)).toEqual(Array(5).fill({ ok: true }));
    expect(executed).toEqual(['root-0', 'root-1', 'root-2', 'root-3', 'bootstrap']);
    for (const at of starts) expect(starts.filter(time => time >= at && time < at + 1000).length).toBeLessThanOrEqual(6);
  } finally { jobs.close(); }
});
it('reactivation detaches only the session reads and an older completion cannot evict their replacements', async () => {
  vi.useFakeTimers(); vi.setSystemTime(90000);
  const queue = (globalThis as any).__piDiffBurstQueue; queue.starts = []; await queue.tail;
  const finish: ((value: unknown) => void)[] = [];
  const invoke = vi.fn((_method: string, _args: unknown) => new Promise(resolve => finish.push(resolve)));
  const transport = boundedTransport(invoke as UiTransport['invoke']);
  const args = { sessionId: 'a' }, otherArgs = { sessionId: 'b' };
  const old = transport.invoke('bootstrap', args), other = transport.invoke('bootstrap', otherArgs);
  expect(transport.invoke('bootstrap', args)).toBe(old);
  await vi.advanceTimersByTimeAsync(0); expect(invoke).toHaveBeenCalledTimes(2);
  invalidateSessionReads(transport, 'a');
  const fresh = transport.invoke('bootstrap', args);
  expect(fresh).not.toBe(old); expect(transport.invoke('bootstrap', otherArgs)).toBe(other);
  await vi.advanceTimersByTimeAsync(0); expect(invoke).toHaveBeenCalledTimes(3);
  finish[0]({ state: 'done', result: 'old' }); await old;
  expect(transport.invoke('bootstrap', args)).toBe(fresh);
  finish[1]({ state: 'done', result: 'other' }); finish[2]({ state: 'done', result: 'fresh' });
  expect(await Promise.all([other, fresh])).toEqual(['other', 'fresh']);
  expect(invoke.mock.calls.every(([method, value]: any) => method === 'jobStart' && !('epoch' in value.args))).toBe(true);
});
