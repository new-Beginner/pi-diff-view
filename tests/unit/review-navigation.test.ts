import { it, expect, vi } from 'vitest';
import { ReviewNavigationStore } from '../../src/core/review-navigation';
it('keeps session tokens beyond 30 minutes, many sessions and restart without cross-window leakage', () => {
  const store = new ReviewNavigationStore();
  const first = store.set({ scope: 'turn', sessionId: 'a', runId: 'run-a' }, 'file-a');
  const other = store.set({ scope: 'turn', sessionId: 'b', runId: 'run-b' });
  store.setActiveSession('b');
  expect(store.get(first.nonce, 'a')?.fileId).toBe('file-a');
  expect(store.get(first.nonce, 'b')).toBeNull();
  for (let i = 0; i < 50; i++) store.set({ scope: 'turn', sessionId: `s-${i}`, runId: 'r' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(first.at + 31 * 60 * 1000);
  try {
    const restarted = new ReviewNavigationStore(); restarted.restore(JSON.parse(JSON.stringify(store.export())));
    expect(restarted.get(first.nonce, 'a')?.request.runId).toBe('run-a');
    expect(restarted.get(other.nonce, 'b')?.sessionId).toBe('b');
    expect(restarted.get(other.nonce, 'a')).toBeNull();
    expect(() => restarted.set({ scope: 'unstaged' })).toThrow('recorded');
    restarted.clear(); expect(restarted.get(first.nonce, 'a')).toBeNull();
  } finally { clock.mockRestore(); }
});
it('updates selected files while retaining the same persistent session capability', () => {
  const store = new ReviewNavigationStore(), request = { scope: 'turn' as const, sessionId: 's', runId: 'r' };
  const first = store.set(request, 'a'), second = store.set(request, 'b');
  expect(second.nonce).toBe(first.nonce); expect(second.revision).toBe(2);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(second.at + 31 * 60 * 1000);
  try { const fresh = store.set(request, 'c'); expect(fresh.nonce).toBe(first.nonce); expect(fresh.revision).toBe(3); expect(store.get(first.nonce, 's')?.fileId).toBe('c'); } finally { clock.mockRestore(); }
});
