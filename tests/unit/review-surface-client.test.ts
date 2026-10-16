import { afterEach, expect, it, vi } from 'vitest';
import { createReviewSurfaceClient } from '../../src/renderer/review-surface-client';
import { ReviewSurfaces } from '../../src/core/review-surfaces';
afterEach(() => { vi.useRealTimers(); });
const nonce = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const surfaces = new ReviewSurfaces(); const requests: any[] = []; let viewSeq = 0;
  const invoke = vi.fn(async (method: string, args: any): Promise<any> => {
    requests.push({ method, args });
    if (method === 'readTurnSelection') return { nonce, revision: 3, sessionId: 'a', request: { scope: 'turn', sessionId: 'a', runId: 'r' } };
    return surfaces.exchange(args);
  });
  const client = createReviewSurfaceClient({ invoke }); client.update('a');
  return { client, surfaces, invoke, requests, view: (ack?: string) => surfaces.exchange({ role: 'view', id: 'view', seq: ++viewSeq, ack }) };
}
it('publishes a selection once and waits for its exact application acknowledgement', async () => {
  const f = fixture(); f.view(); const guard = vi.fn();
  try {
    const ticket = await f.client.channel.prepare('a', `diff-view:${nonce}`, guard);
    const selected = f.view(); f.view(selected.key);
    await f.client.channel.confirm(ticket, guard);
    expect(f.requests.filter(row => row.method === 'reviewSurface' && row.args?.nonce)).toHaveLength(1);
    expect(guard).toHaveBeenCalled();
  } finally { f.client.dispose(); }
});
it('stops after a switch away and back, and does not replay the selection', async () => {
  const f = fixture();
  try {
    const ticket = await f.client.channel.prepare('a', `diff-view:${nonce}`, () => {});
    f.client.update('b'); f.client.update('a');
    await expect(f.client.channel.confirm(ticket, () => {})).rejects.toThrow('Session changed');
    expect(f.requests.filter(row => row.method === 'reviewSurface' && row.args?.nonce)).toHaveLength(1);
  } finally { f.client.dispose(); }
});
it('refuses ambiguous instances, and times out rather than treating tab activation as application', async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    f.surfaces.exchange({ role: 'renderer', id: 'other', seq: 1, sessionId: 'b' });
    await expect(f.client.channel.prepare('a', `diff-view:${nonce}`, () => {})).rejects.toThrow('多个窗口');
    f.surfaces.exchange({ role: 'renderer', id: 'other', seq: 2, release: true });
    const ticket = await f.client.channel.prepare('a', `diff-view:${nonce}`, () => {});
    const pending = expect(f.client.channel.confirm(ticket, () => {})).rejects.toThrow('未确认');
    await vi.advanceTimersByTimeAsync(12500); await pending;
  } finally { f.client.dispose(); }
});
