import { afterEach, it, expect, vi } from 'vitest';
import { publicSessionContext } from '../../src/core/public-session-context';
import { hostEvidenceMessages } from '../../src/core/host-transcript';
import { createHostStateAdapter } from '../../src/renderer/host-state-adapter';
import { createRunningChangesController, type RunningView } from '../../src/renderer/running-changes';
import { createPluginReviewAdapter, runningActivity, type PluginReviewAdapter, type RunningActivity } from '../../src/renderer/plugin-review-adapter';
import type { RunningChanges } from '../../src/core/contracts';
const task: RunningActivity = { sessionId: 's', taskId: 'user', since: 100 };
const summary: RunningChanges = { runId: 'run', sessionId: 's', startedAt: 101, fileCount: 1, additions: 11, deletions: 0, locale: 'zh-CN', base: 'light' };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers(); let result: RunningChanges | null = summary, view: RunningView = { summary: null, busy: false, error: '' };
  const adapter = { reveal: vi.fn(async () => {}), open: vi.fn(async (_session, _location, guard) => guard?.()) } as unknown as PluginReviewAdapter;
  const invoke = vi.fn(async (method: string, _args?: unknown) => method === 'runningChanges' ? result : method === 'selectTurn' ? { nonce: '00000000-0000-4000-8000-000000000001' } : { ok: true });
  const controller = createRunningChangesController({ invoke: invoke as any }, adapter, next => view = next);
  return { controller, adapter, invoke, get view() { return view; }, result(next: RunningChanges | null) { result = next; } };
}
it('updates net totals while running and opens latest-turn mode with the session alone', async () => {
  const f = fixture(); f.controller.setActivity(task); await flush(); expect(f.view.summary).toEqual(summary);
  f.result({ ...summary, fileCount: 2, additions: 20 }); await vi.advanceTimersByTimeAsync(1000); expect(f.view.summary?.fileCount).toBe(2);
  await f.controller.open(); expect(f.adapter.open).toHaveBeenCalledWith('s', 'diff-view:00000000-0000-4000-8000-000000000001', expect.any(Function));
  expect(f.invoke).toHaveBeenCalledWith('selectTurn', { scope: 'lastTurn', sessionId: 's' }); expect(f.view.busy).toBe(false); f.controller.dispose();
});
it('always sends the same latest-turn jump without consulting old totals or UI state', async () => {
  const f = fixture(); f.controller.setActivity(task); await flush();
  await f.controller.open(); await f.controller.open();
  expect(f.invoke.mock.calls.filter(([method]) => method === 'selectTurn')).toEqual([
    ['selectTurn', { scope: 'lastTurn', sessionId: 's' }], ['selectTurn', { scope: 'lastTurn', sessionId: 's' }]
  ]);
  f.result(null); await vi.advanceTimersByTimeAsync(1000); expect(f.view.summary).toBeNull();
  await f.controller.open(); expect(f.adapter.open).toHaveBeenCalledTimes(3); f.controller.dispose();
});
it('hides immediately on completion, ignores a late poll and stops the timer', async () => {
  const f = fixture(); let release!: (data: RunningChanges) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => release = resolve) as any);
  f.controller.setActivity(task); f.controller.setActivity(null); release(summary); await flush();
  expect(f.view.summary).toBeNull(); await vi.advanceTimersByTimeAsync(5000); expect(f.invoke).toHaveBeenCalledTimes(1); f.controller.dispose();
});
it.each(['new-task', 'away-back', 'unload'])('invalidates pending clicks after %s', async mode => {
  const f = fixture(); f.controller.setActivity(task); await flush(); let release!: () => void;
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (method, args) => { if (method === 'selectTurn') await new Promise<void>(resolve => release = resolve); return original(method, args); });
  const opening = f.controller.open(); await flush(); expect(release).toBeTypeOf('function');
  if (mode === 'unload') f.controller.dispose();
  else { f.controller.setActivity(null); f.controller.setActivity(mode === 'new-task' ? { ...task, taskId: 'new', since: 200 } : task); }
  release(); await opening; expect(f.adapter.open).not.toHaveBeenCalled(); f.controller.dispose();
});
it('does not inherit earlier totals at a new user boundary or from another session', async () => {
  const f = fixture(); f.controller.setActivity(task); await flush();
  f.controller.setActivity({ ...task, taskId: 'new', since: 200 }); expect(f.view.summary).toBeNull(); await flush(); expect(f.view.summary).toBeNull();
  f.result({ ...summary, sessionId: 'other' }); await vi.advanceTimersByTimeAsync(1000); expect(f.view.summary).toBeNull(); f.controller.dispose();
});
it('keeps verified totals on a navigation failure; only polling controls their visibility', async () => {
  const f = fixture(); f.controller.setActivity(task); await flush();
  f.invoke.mockRejectedValueOnce(new Error('Bridge unavailable')); await vi.advanceTimersByTimeAsync(1000); expect(f.view.summary).toEqual(summary);
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (method, args) => { if (method === 'selectTurn') throw new Error('Bridge unavailable'); return original(method, args); });
  await f.controller.open(); expect(f.adapter.open).not.toHaveBeenCalled(); expect(f.view.summary).toEqual(summary);
  f.result({ ...summary, fileCount: 0 }); await vi.advanceTimersByTimeAsync(1000); expect(f.view.summary).toBeNull();
  f.controller.setActivity(null); f.controller.setActivity(task); expect(f.view.summary).toBeNull(); f.controller.dispose();
});
it('extracts only public current task metadata and ignores steering and nested users', () => {
  const context = publicSessionContext({ sessionId: 's', statusKnown: true, running: true, complete: true, messages: hostEvidenceMessages([{ id: 'old', role: 'user', createdAt: 1 }, { id: 'current', role: 'user', createdAt: 100 }, { id: 'steer', role: 'user', steering: true, createdAt: 200 }, { id: 'nested', role: 'user', parentToolCallId: 'tool', createdAt: 300 }]) });
  expect(runningActivity(context)).toEqual({ sessionId: 's', taskId: 'current', since: 100 });
  for (const changed of [{ statusKnown: false }, { running: false }, { taskId: undefined }, { since: undefined }]) expect(runningActivity({ ...context, ...changed })).toBeNull();
});
it('polls public activity without token notifications and releases on unload', async () => {
  vi.useFakeTimers(); let running = true;
  const read = vi.fn(async () => ({ sessionId: 's', running, statusKnown: true, taskId: 'user', since: 100 }));
  const adapter = createHostStateAdapter({ read, session: () => 's' });
  const listener = vi.fn(); await adapter.subscribeActivity(listener); await flush();
  expect(listener).toHaveBeenLastCalledWith({ sessionId: 's', taskId: 'user', since: 100 });
  const count = listener.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(listener).toHaveBeenCalledTimes(count);
  running = false; await vi.advanceTimersByTimeAsync(1000); expect(listener).toHaveBeenLastCalledWith(null);
  adapter.close(); const calls = read.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(calls);
});
it('uses authoritative public metadata rather than the visible transcript window', () => {
  const context = publicSessionContext({ sessionId: 's', running: true, statusKnown: true, complete: true, messages: hostEvidenceMessages([{ id: 'old', role: 'user', createdAt: 1 }, { id: 'current', role: 'user', createdAt: 100 }]) });
  expect(runningActivity(context)).toEqual({ sessionId: 's', taskId: 'current', since: 100 });
  expect(runningActivity(publicSessionContext({ sessionId: 's', running: true, statusKnown: true, complete: true, messages: hostEvidenceMessages([{ id: 'current', role: 'user', createdAt: 100 }, { id: 'conflict', role: 'user', createdAt: 100 }]) }))).toBeNull();
});
it('diagnoses query failure and recovers on the next poll without resurrecting old tasks', async () => {
  const f = fixture(), stages: string[] = [];
  const controller = createRunningChangesController({ invoke: f.invoke as any }, f.adapter, () => {}, stage => stages.push(stage));
  f.invoke.mockRejectedValueOnce(new Error('Bridge failed'));
  controller.setActivity(task); await flush(); expect(stages).toContain('running-query-error');
  await vi.advanceTimersByTimeAsync(1000); expect(stages).toContain('running-visible');
  controller.setActivity(null); expect(stages.at(-1)).toBe('running-idle'); controller.dispose(); f.controller.dispose();
});
it('an unidentified latest public user cannot reuse old totals', () => {
  const messages = [{ id: 'bad-old', role: 'user' }, { id: 'current', role: 'user', createdAt: 100 }];
  const activity = (rows: unknown[]) => runningActivity(publicSessionContext({ sessionId: 's', running: true, statusKnown: true, complete: true, messages: hostEvidenceMessages(rows) }));
  expect(activity(messages)).toEqual({ sessionId: 's', taskId: 'current', since: 100 });
  expect(activity([...messages, { id: 'bad-new', role: 'user' }])).toBeNull();
});
it('restores A synchronously before revalidation and ignores a late B response', async () => {
  const f = fixture(); f.controller.setActivity(task); await flush();
  let releaseB!: (data: RunningChanges) => void, releaseA!: (data: RunningChanges | null) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => releaseB = resolve) as any);
  f.controller.setActivity({ sessionId: 'b', taskId: 'b-user', since: 100 }); expect(f.view.summary).toBeNull();
  f.invoke.mockImplementationOnce(() => new Promise(resolve => releaseA = resolve) as any);
  f.controller.setActivity(task); expect(f.view.summary).toEqual(summary);
  releaseB({ ...summary, runId: 'b-run', sessionId: 'b' }); await flush(); expect(f.view.summary).toEqual(summary);
  releaseA(null); await flush(); expect(f.view.summary).toBeNull();
  f.controller.setActivity(null); f.controller.setActivity(task); expect(f.view.summary).toBeNull(); f.controller.dispose();
});
it('clicks without a second summary query and preserves remount cache only for the same transport/task', async () => {
  const f = fixture(); const transport = { invoke: f.invoke as any };
  let view: RunningView = { summary: null, busy: false, error: '' };
  const first = createRunningChangesController(transport, f.adapter, next => view = next);
  first.setActivity(task); await flush(); const queries = f.invoke.mock.calls.filter(([method]) => method === 'runningChanges').length;
  await first.open(); expect(f.invoke.mock.calls.filter(([method]) => method === 'runningChanges')).toHaveLength(queries); first.dispose();
  f.invoke.mockImplementationOnce(() => new Promise(() => {}) as any);
  const second = createRunningChangesController(transport, f.adapter, next => view = next);
  second.setActivity(task); expect(view.summary).toEqual(summary);
  second.setActivity({ ...task, taskId: 'next' }); expect(view.summary).toBeNull(); second.dispose();
  const isolated = createRunningChangesController({ invoke: f.invoke as any }, f.adapter, next => view = next);
  isolated.setActivity(task); expect(view.summary).toBeNull(); isolated.dispose(); f.controller.dispose();
});
