import { expect, it } from 'vitest';
import { ReviewSurfaces } from '../../src/core/review-surfaces';
const r = { role: 'renderer' as const, id: 'renderer-1', seq: 1, sessionId: 'a' };
const v = { role: 'view' as const, id: 'view-1', seq: 1 };
it('pairs only unique live instances, follows sessions and confirms exact revisions', () => {
  let now = 100; const surfaces = new ReviewSurfaces(() => now);
  surfaces.exchange(r);
  const initial = surfaces.exchange(v); expect(initial.sessionId).toBe('a');
  const targeted = surfaces.exchange({ ...r, seq: 2, nonce: 'token', selectionRevision: 2 });
  expect(targeted.confirmed).toBe(false);
  expect(surfaces.exchange({ ...v, seq: 2, ack: initial.key }).nonce).toBe('token');
  expect(surfaces.exchange({ ...r, seq: 3 }).confirmed).toBe(false);
  const selected = surfaces.exchange({ ...v, seq: 3 });
  surfaces.exchange({ ...v, seq: 4, ack: selected.key });
  expect(surfaces.exchange({ ...r, seq: 4 }).confirmed).toBe(true);
  surfaces.exchange({ ...r, seq: 5, sessionId: 'b' });
  expect(surfaces.exchange({ ...v, seq: 5 })).toMatchObject({ sessionId: 'b', nonce: undefined });
  expect(surfaces.exchange({ ...r, seq: 4, sessionId: 'a' }).state).toBe('stale');
  expect(surfaces.exchange({ ...v, seq: 6 }).sessionId).toBe('b');
  now += 15001; expect(surfaces.exchange({ ...v, seq: 7 }).state).toBe('waiting');
});
it('fails closed for multiple renderers or views, releases and expires leases', () => {
  const surfaces = new ReviewSurfaces(); surfaces.exchange(r); surfaces.exchange(v);
  expect(surfaces.exchange({ ...r, id: 'renderer-2' }).state).toBe('ambiguous');
  expect(surfaces.exchange({ ...v, seq: 2 }).sessionId).toBeNull();
  surfaces.exchange({ ...r, id: 'renderer-2', seq: 2, release: true });
  expect(surfaces.exchange({ ...v, seq: 3 }).sessionId).toBe('a');
  expect(surfaces.exchange({ ...v, id: 'view-2' }).state).toBe('ambiguous');
  surfaces.clear(); expect(surfaces.exchange({ ...v, seq: 4 }).state).toBe('waiting');
});
it('rejects invalid identities and bounds live registrations', () => {
  const surfaces = new ReviewSurfaces();
  expect(() => surfaces.exchange({ ...r, id: '' })).toThrow();
  expect(() => surfaces.exchange({ ...r, seq: NaN })).toThrow();
  for (let i = 0; i < 32; i++) surfaces.exchange({ ...r, id: `renderer-${i}` });
  expect(() => surfaces.exchange({ ...r, id: 'overflow' })).toThrow();
});
