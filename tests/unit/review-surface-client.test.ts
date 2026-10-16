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
    return surfaces.request(args);
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
it('rejects a prepare reply delayed across A → B → A even when the DOM guard matches again', async () => {
  const f = fixture(), invoke = f.invoke.getMockImplementation()!; let release!: () => void;
  f.invoke.mockImplementation(async (method, args) => {
    const reply = await invoke(method, args);
    if (method === 'reviewSurface' && args?.nonce) await new Promise<void>(resolve => release = resolve);
    return reply;
  });
  try {
    const preparing = f.client.channel.prepare('a', `diff-view:${nonce}`, () => {});
    const rejected = expect(preparing).rejects.toThrow('Session changed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.client.update('b'); f.client.update('a'); release(); await rejected;
  } finally { f.client.dispose(); }
});
it('clears the backend selection when away/back updates coalesce behind an in-flight heartbeat', async () => {
  const surfaces = new ReviewSurfaces(); let release!: () => void, updates = 0;
  const client = createReviewSurfaceClient({ invoke: async (method: string, args: any): Promise<any> => {
    if (method === 'readTurnSelection') return { nonce, revision: 3, sessionId: 'a' };
    const reply = await surfaces.request(args);
    if (args.seq === 1) await new Promise<void>(resolve => release = resolve);
    if (args.seq > 2 && !args.nonce) updates++;
    return reply;
  } });
  try {
    client.update('a'); await client.channel.prepare('a', `diff-view:${nonce}`, () => {});
    client.update('b'); client.update('a'); release();
    await vi.waitFor(() => expect(updates).toBeGreaterThan(0));
    expect(surfaces.exchange({ role: 'view', id: 'view', seq: 1 }).nonce).toBeUndefined();
  } finally { client.dispose(); }
});
