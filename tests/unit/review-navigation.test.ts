import { it, expect, vi } from 'vitest';
import { ReviewNavigationStore } from '../../src/core/review-navigation';
it('isolates sessions, preserves the view token across file selections and enforces expiry/capacity', () => {
  const store = new ReviewNavigationStore();
  const first = store.set({ scope: 'turn', sessionId: 'a', runId: 'run-a' }, 'file-a');
  const other = store.set({ scope: 'turn', sessionId: 'b', runId: 'run-b' });
  expect(store.get(first.nonce)?.fileId).toBe('file-a'); expect(store.get(other.nonce)?.sessionId).toBe('b');
  store.setActiveSession('a'); expect(store.get(other.nonce)).toBeNull();
  store.setActiveSession('b'); expect(store.get(first.nonce)).toBeNull(); expect(store.get(other.nonce)?.sessionId).toBe('b');
  store.setActiveSession('a'); expect(store.get(first.nonce)?.fileId).toBe('file-a');
  const replaced = store.set({ scope: 'turn', sessionId: 'a', runId: 'run-next' });
  expect(replaced.nonce).toBe(first.nonce); expect(replaced.revision).toBe(first.revision + 1); expect(store.get(first.nonce)?.request.runId).toBe('run-next');
  for (let i = 0; i < 33; i++) store.set({ scope: 'turn', sessionId: `s-${i}`, runId: 'r' });
  expect(store.get(other.nonce)).toBeNull();
  const latest = store.set({ scope: 'turn', sessionId: 'last', runId: 'r' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(latest.at + 31 * 60 * 1000);
  expect(store.get(latest.nonce)).toBeNull(); clock.mockRestore();
  expect(() => store.set({ scope: 'unstaged' })).toThrow('recorded');
  store.clear(); expect(store.get(replaced.nonce)).toBeNull();
});
it('updates the latest file even for repeated clicks and issues a new capability after expiry', () => {
  const store = new ReviewNavigationStore(), request = { scope: 'turn' as const, sessionId: 's', runId: 'r' };
  const first = store.set(request, 'a'), second = store.set(request, 'b'), third = store.set(request, 'b');
  expect([first.nonce, second.nonce, third.nonce]).toEqual([first.nonce, first.nonce, first.nonce]);
  expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
  expect(store.get(first.nonce)?.fileId).toBe('b');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(third.at + 31 * 60 * 1000);
  try { const fresh = store.set(request, 'c'); expect(fresh.nonce).not.toBe(first.nonce); expect(fresh.revision).toBe(1); expect(store.get(first.nonce)).toBeNull(); } finally { clock.mockRestore(); }
});
