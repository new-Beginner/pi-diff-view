import { expect, it } from 'vitest';
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
