import { expect, it, vi } from 'vitest';
import { FileOpenRequests } from '../../src/core/file-open';
it('delivers exactly once to its own session and acknowledges success', () => {
  const requests = new FileOpenRequests(), target = { sessionId: 's', path: 'D:/中文 folder/a.ts' };
  const { requestId } = requests.add(target);
  expect(requests.take('other')).toEqual([]);
  expect(requests.status(requestId).state).toBe('pending');
  expect(() => requests.complete(requestId, 's')).toThrow();
  expect(requests.take('s')).toEqual([{ ...target, requestId }]);
  expect(requests.take('s')).toEqual([]);
  expect(() => requests.complete(requestId, 'other')).toThrow();
  requests.complete(requestId, 's'); expect(requests.status(requestId).state).toBe('done');
});
it('reports renderer errors, expires without a late open, and clears requests', () => {
  let now = 0; const requests = new FileOpenRequests(() => now);
  const { requestId } = requests.add({ sessionId: 's', path: '/project/a.ts' });
  requests.take('s'); requests.complete(requestId, 's', 'File Manager unavailable');
  expect(requests.status(requestId)).toEqual({ state: 'error', error: 'File Manager unavailable' });
  const pending = requests.add({ sessionId: 's', path: '/project/b.ts' });
  now = 10001; expect(requests.take('s')).toEqual([]); expect(requests.status(pending.requestId).state).toBe('error');
  requests.clear(); expect(() => requests.status(requestId)).toThrow();
});
it('bounds idle listeners to 1.5 seconds and cancels only the matching generation', async () => {
  vi.useFakeTimers();
  try {
    const requests = new FileOpenRequests(), first = requests.listen('s', 'first');
    const second = requests.listen('s', 'second'); await expect(first).resolves.toEqual([]);
    requests.cancelListen('s', 'first');
    let resolved = false; second.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(1499); expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(second).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0); requests.clear();
  } finally { vi.useRealTimers(); }
});
it('completion wakes status waiters without a polling delay and clear releases idle listeners', async () => {
  vi.useFakeTimers();
  try {
    const requests = new FileOpenRequests(), listener = requests.listen('s', 'listener');
    const { requestId } = requests.add({ sessionId: 's', path: '/project/a.ts' });
    expect(await listener).toHaveLength(1);
    const status = requests.waitStatus(requestId);
    requests.complete(requestId, 's'); await expect(status).resolves.toEqual({ state: 'done' });
    const idle = requests.listen('s', 'idle'); requests.clear(); await expect(idle).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
