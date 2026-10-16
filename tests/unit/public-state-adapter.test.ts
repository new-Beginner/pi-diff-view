import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activityDiagnostic, createHostStateAdapter, runningActivity, type SessionContext } from '../../src/renderer/host-state-adapter';

const active = (sessionId = 'A', taskId = 'task'): SessionContext => ({ sessionId, running: true, statusKnown: true, taskId, since: 100 });
const unknown = (sessionId: string): SessionContext => ({ sessionId, running: false, statusKnown: false });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const adapters: ReturnType<typeof createHostStateAdapter>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.close(); vi.useRealTimers(); });
function fixture(initial: string | null = 'A') {
  let sessionId = initial, notify = () => {};
  const disconnect = vi.fn();
  const observe = vi.fn((callback: () => void) => { notify = callback; return { disconnect }; });
  const read = vi.fn(async (id: string): Promise<SessionContext> => active(id));
  const adapter = createHostStateAdapter({ read, session: () => sessionId, observe }); adapters.push(adapter);
  return { adapter, read, observe, disconnect, notify: () => notify(), switch(id: string | null) { sessionId = id; notify(); } };
}

it('polls immediately and every second, sharing a single source, cache and observer', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn(), second = vi.fn();
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity); await flush();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledWith('A');
  expect(evidence).toHaveBeenNthCalledWith(1, 'A', unknown('A'));
  expect(evidence).toHaveBeenLastCalledWith('A', active());
  expect(activity).toHaveBeenLastCalledWith({ sessionId: 'A', taskId: 'task', since: 100 });
  await f.adapter.subscribeEvidence(second);
  expect(second).toHaveBeenCalledTimes(1); expect(second).toHaveBeenLastCalledWith('A', active());
  expect(f.observe).toHaveBeenCalledTimes(1);
  f.notify(); f.notify(); await vi.advanceTimersByTimeAsync(999); expect(f.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.read).toHaveBeenCalledTimes(2);
  expect(evidence).toHaveBeenCalledTimes(2); expect(activity).toHaveBeenCalledTimes(2);
});
it('keeps a slow read single-flight even across repeated notifications and poll intervals', async () => {
  const f = fixture(), pending = deferred<SessionContext>(); f.read.mockReturnValueOnce(pending.promise);
  await f.adapter.subscribeEvidence(() => {}); await f.adapter.subscribeActivity(() => {});
  f.notify(); await vi.advanceTimersByTimeAsync(5000); f.notify();
  expect(f.read).toHaveBeenCalledTimes(1);
  pending.resolve(active()); await flush();
  await vi.advanceTimersByTimeAsync(999); expect(f.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.read).toHaveBeenCalledTimes(2);
});
it('publishes errors as unknown, clears activity and recovers without claiming known idle', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn(), diagnostic = vi.fn();
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity, diagnostic); await flush();
  f.read.mockRejectedValueOnce(new Error('Unavailable')); await vi.advanceTimersByTimeAsync(1000);
  expect(evidence).toHaveBeenLastCalledWith('A', unknown('A'));
  expect(activity).toHaveBeenLastCalledWith(null); expect(diagnostic).toHaveBeenLastCalledWith('running-identity-missing');
  expect(diagnostic).not.toHaveBeenCalledWith('running-idle');
  await vi.advanceTimersByTimeAsync(1000); expect(activity).toHaveBeenLastCalledWith({ sessionId: 'A', taskId: 'task', since: 100 });
  f.read.mockResolvedValueOnce({ sessionId: 'A', running: false, statusKnown: true });
  await vi.advanceTimersByTimeAsync(1000); expect(diagnostic).toHaveBeenLastCalledWith('running-idle');
});
it('handles an initial rejection or synchronous read exception as unknown', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn(), diagnostic = vi.fn();
  f.read.mockImplementation(() => { throw new Error('Not ready'); });
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity, diagnostic); await flush();
  expect(evidence).toHaveBeenLastCalledWith('A', unknown('A')); expect(activity).toHaveBeenLastCalledWith(null);
  expect(diagnostic.mock.calls.map(([stage]) => stage)).toEqual(['running-identity-missing']);
  await vi.advanceTimersByTimeAsync(1000); expect(f.read).toHaveBeenCalledTimes(2);
});
it('preserves explicit unknown status and never derives an activity from it', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn(), diagnostic = vi.fn();
  f.read.mockResolvedValue({ ...active(), statusKnown: false });
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity, diagnostic); await flush();
  expect(evidence).toHaveBeenLastCalledWith('A', expect.objectContaining({ statusKnown: false }));
  expect(activity).toHaveBeenLastCalledWith(null); expect(diagnostic).toHaveBeenLastCalledWith('running-identity-missing');
});
it('rejects wrong-session/malformed public responses rather than adopting foreign state', async () => {
  const f = fixture(), evidence = vi.fn(); f.read.mockResolvedValueOnce(active('B'));
  await f.adapter.subscribeEvidence(evidence); await flush(); expect(evidence).toHaveBeenLastCalledWith('A', unknown('A'));
  f.read.mockResolvedValueOnce(undefined as unknown as SessionContext);
  await vi.advanceTimersByTimeAsync(1000); expect(evidence).toHaveBeenLastCalledWith('A', unknown('A'));
});
it('strips evidence strings and private fields while forwarding public metadata revisions', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn();
  f.read.mockResolvedValue({ ...active(), root: '/project', mainRunning: false, evidence: 'must stay backend-side', evidenceRevision: 'r1', messages: ['private'] } as SessionContext);
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity); await flush();
  const context = evidence.mock.lastCall![1];
  expect(context).toMatchObject({ root: '/project', mainRunning: false, evidenceRevision: 'r1' });
  expect(context).not.toHaveProperty('evidence'); expect(context).not.toHaveProperty('messages');
  const count = activity.mock.calls.length;
  f.read.mockResolvedValue({ ...active(), evidenceRevision: 'r2' }); await vi.advanceTimersByTimeAsync(1000);
  expect(evidence).toHaveBeenLastCalledWith('A', expect.objectContaining({ evidenceRevision: 'r2' }));
  expect(activity).toHaveBeenCalledTimes(count);
});
it('invalidates immediately on a session switch, then reads the new owner', async () => {
  const f = fixture(), evidence = vi.fn(), activity = vi.fn();
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity); await flush();
  const pending = deferred<SessionContext>(); f.read.mockReturnValueOnce(pending.promise);
  f.switch('B'); expect(evidence).toHaveBeenLastCalledWith('B', unknown('B')); expect(activity).toHaveBeenLastCalledWith(null);
  await flush(); expect(f.read).toHaveBeenLastCalledWith('B');
  pending.resolve(active('B')); await flush(); expect(evidence).toHaveBeenLastCalledWith('B', active('B'));
});
it.each(['resolve', 'reject'] as const)('discards a stale A → B → A %s using generations, not just ids', async mode => {
  const f = fixture(), pending = deferred<SessionContext>(), evidence = vi.fn(), activity = vi.fn();
  f.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(active('A', 'fresh'));
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(activity); await flush();
  f.switch('B'); f.switch('A');
  expect(evidence.mock.calls.map(([id]) => id)).toEqual(['A', 'B', 'A']);
  await vi.advanceTimersByTimeAsync(5000); expect(f.read).toHaveBeenCalledTimes(1);
  if (mode === 'resolve') pending.resolve(active('A', 'stale')); else pending.reject(new Error('Old failure'));
  await flush(); expect(f.read).toHaveBeenCalledTimes(2);
  expect(evidence).toHaveBeenLastCalledWith('A', active('A', 'fresh'));
  expect(evidence.mock.calls.some(([, context]) => context?.taskId === 'stale')).toBe(false);
  expect(activity).toHaveBeenLastCalledWith({ sessionId: 'A', taskId: 'fresh', since: 100 });
});
it('queues only the latest session behind an old flight and never emits its result', async () => {
  const f = fixture(), pending = deferred<SessionContext>(), evidence = vi.fn(); f.read.mockReturnValueOnce(pending.promise);
  await f.adapter.subscribeEvidence(evidence); await flush(); f.switch('B'); f.switch('C');
  pending.resolve(active()); await flush();
  expect(f.read.mock.calls.map(([id]) => id)).toEqual(['A', 'C']);
  expect(evidence).toHaveBeenLastCalledWith('C', active('C'));
  expect(evidence.mock.calls.some(([, context]) => context?.sessionId === 'A' && context.statusKnown)).toBe(false);
});
it('clears null sessions immediately and follows them by polling without an observer', async () => {
  let sessionId: string | null = null; const read = vi.fn(async (id: string) => active(id)), evidence = vi.fn();
  const adapter = createHostStateAdapter({ read, session: () => sessionId }); adapters.push(adapter);
  await adapter.subscribeEvidence(evidence); expect(evidence).toHaveBeenLastCalledWith(null, undefined);
  await vi.advanceTimersByTimeAsync(1000); expect(read).not.toHaveBeenCalled();
  sessionId = 'A'; await vi.advanceTimersByTimeAsync(1000); expect(evidence).toHaveBeenLastCalledWith('A', active());
  sessionId = null; await vi.advanceTimersByTimeAsync(1000); expect(evidence).toHaveBeenLastCalledWith(null, undefined);
});
it('keeps polling until the last subscriber leaves and ignores a late result after unsubscribe', async () => {
  const f = fixture(), pending = deferred<SessionContext>(), evidence = vi.fn(), activity = vi.fn();
  const stopEvidence = await f.adapter.subscribeEvidence(evidence), stopActivity = await f.adapter.subscribeActivity(activity); await flush();
  stopEvidence(); stopEvidence(); expect(f.disconnect).not.toHaveBeenCalled();
  f.read.mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(1000);
  expect(f.read).toHaveBeenCalledTimes(2); stopActivity(); expect(f.disconnect).toHaveBeenCalledTimes(1);
  const evidenceCount = evidence.mock.calls.length, activityCount = activity.mock.calls.length;
  pending.resolve(active('A', 'late')); await flush(); f.notify(); await vi.advanceTimersByTimeAsync(5000);
  expect(evidence).toHaveBeenCalledTimes(evidenceCount); expect(activity).toHaveBeenCalledTimes(activityCount); expect(f.read).toHaveBeenCalledTimes(2);
});
it('resubscribes with a fresh generation while a previous lifecycle read is still pending', async () => {
  const f = fixture(), pending = deferred<SessionContext>(), stale = vi.fn(), fresh = vi.fn(); f.read.mockReturnValueOnce(pending.promise);
  const stop = await f.adapter.subscribeEvidence(stale); await flush(); stop();
  await f.adapter.subscribeEvidence(fresh); expect(fresh).toHaveBeenLastCalledWith('A', unknown('A'));
  pending.resolve(active('A', 'stale')); await flush();
  expect(fresh).toHaveBeenLastCalledWith('A', active()); expect(stale).toHaveBeenCalledTimes(1); expect(f.observe).toHaveBeenCalledTimes(2);
});
it.each(['resolve', 'reject'] as const)('close ignores late %s and rejects any new subscription', async mode => {
  const f = fixture(), pending = deferred<SessionContext>(), listener = vi.fn(); f.read.mockReturnValueOnce(pending.promise);
  const stop = await f.adapter.subscribeEvidence(listener); await flush(); f.adapter.close(); f.adapter.close(); stop();
  if (mode === 'resolve') pending.resolve(active()); else pending.reject(new Error('Late failure'));
  await flush(); f.notify(); await vi.advanceTimersByTimeAsync(5000);
  expect(listener).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); expect(f.disconnect).toHaveBeenCalledTimes(1);
  await expect(f.adapter.subscribeEvidence(listener)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
  await expect(f.adapter.subscribeActivity(listener)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
});
it('derives activity only from normalized running identity, with a zero-since turn fallback', () => {
  expect(runningActivity(active())).toEqual({ sessionId: 'A', taskId: 'task', since: 100 });
  for (const changed of [{ running: false }, { statusKnown: false }, { taskId: '' }, { since: 0 }, { since: -1 }, { since: NaN }, { since: 1.1 }, { since: Date.now() + 1 }]) {
    expect(runningActivity({ ...active(), ...changed })).toBeNull();
  }
  expect(runningActivity({ ...active(), taskId: undefined, since: 0, turnId: 'turn' })).toEqual({ sessionId: 'A', taskId: 'turn:turn', since: 0, turnId: 'turn' });
  expect(runningActivity({ ...active(), since: -1, turnId: 'turn' })).toBeNull();
  expect(activityDiagnostic(unknown('A'))).toBe('running-identity-missing');
  expect(activityDiagnostic({ sessionId: 'A', running: true, statusKnown: true })).toBe('running-identity-missing');
});
it('fails closed when a response omits the public statusKnown contract', async () => {
  const f = fixture(), evidence = vi.fn(), diagnostic = vi.fn();
  f.read.mockResolvedValue({ sessionId: 'A', running: false });
  await f.adapter.subscribeEvidence(evidence); await f.adapter.subscribeActivity(() => {}, diagnostic); await flush();
  expect(evidence).toHaveBeenLastCalledWith('A', unknown('A')); expect(diagnostic).not.toHaveBeenCalledWith('running-idle');
});
it('checks ownership while a read is pending even without a DOM observer', async () => {
  let sessionId = 'A'; const pending = deferred<SessionContext>(), evidence = vi.fn();
  const read = vi.fn(async (id: string) => active(id)).mockReturnValueOnce(pending.promise);
  const adapter = createHostStateAdapter({ read, session: () => sessionId }); adapters.push(adapter);
  await adapter.subscribeEvidence(evidence); await flush(); sessionId = 'B'; await vi.advanceTimersByTimeAsync(1000);
  expect(evidence).toHaveBeenLastCalledWith('B', unknown('B')); expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(active()); await flush(); expect(read).toHaveBeenLastCalledWith('B'); expect(evidence).toHaveBeenLastCalledWith('B', active('B'));
});
it('can close during the initial notification without installing observers or timers', async () => {
  const f = fixture(); await expect(f.adapter.subscribeEvidence(() => f.adapter.close())).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
  await flush(); expect(f.observe).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
