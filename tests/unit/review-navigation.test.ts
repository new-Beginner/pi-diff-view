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
it('replaces a historical selection with unpinned latest mode and restores it per session', () => {
  const store = new ReviewNavigationStore();
  const old = store.set({ scope: 'turn', sessionId: 's', runId: 'old-run', root: '/old-project' }, 'old-file');
  const latest = store.set({ scope: 'lastTurn', sessionId: 's' });
  expect(latest.nonce).toBe(old.nonce); expect(latest.revision).toBe(old.revision + 1);
  expect(latest.request).toEqual({ scope: 'lastTurn', sessionId: 's' }); expect(latest.fileId).toBeUndefined();
  const restored = new ReviewNavigationStore(); restored.restore(JSON.parse(JSON.stringify(store.export())));
  expect(restored.get(latest.nonce, 's')?.request).toEqual(latest.request);
  expect(restored.get(latest.nonce, 'other')).toBeNull();
  for (const pinned of [{ runId: 'old-run' }, { root: '/old-project' }]) {
    expect(() => store.set({ scope: 'lastTurn', sessionId: 's', ...pinned })).toThrow('cannot pin');
    const invalid = new ReviewNavigationStore(); invalid.restore([{ ...latest, request: { ...latest.request, ...pinned } }]);
    expect(invalid.get(latest.nonce, 's')).toBeNull();
  }
  expect(() => store.set({ scope: 'lastTurn', sessionId: 's' }, 'old-file')).toThrow('cannot pin');
  const history = store.set({ scope: 'turn', sessionId: 's', runId: 'old-run' }, 'old-file');
  expect(history.request.scope).toBe('turn'); expect(history.fileId).toBe('old-file');
});
