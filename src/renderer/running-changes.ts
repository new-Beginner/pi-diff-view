import type { RunningChanges, UiTransport } from '../core/contracts';
import type { PluginReviewAdapter, RunningActivity } from './plugin-review-adapter';
export interface RunningView { summary: RunningChanges | null; busy: boolean; error: string }
// The transport belongs to one renderer lifetime. Retain exact task identities across
// composer remounts, but never carry a cache into another host/plugin lifetime.
const caches = new WeakMap<UiTransport, Map<string, RunningChanges>>();
const taskKey = (task: RunningActivity) => JSON.stringify([task.sessionId, task.taskId, task.since, task.turnId ?? null]);
/** Epochs invalidate every async path, including a switch away and back to the same task. */
export function createRunningChangesController(transport: UiTransport, adapter: PluginReviewAdapter, publish: (view: RunningView) => void, report: (stage: string) => void = () => {}) {
  const cache = caches.get(transport) ?? new Map<string, RunningChanges>(); caches.set(transport, cache);
  let activity: RunningActivity | null = null, epoch = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: RunningView = { summary: null, busy: false, error: '' };
  let lastDiagnostic = '';
  const diagnose = (stage: string) => { if (stage !== lastDiagnostic) { lastDiagnostic = stage; report(stage); } };
  const emit = (next: RunningView) => { view = next; if (!disposed) publish(view); };
  const valid = (version: number) => !disposed && epoch === version && activity !== null;
  const matches = (result: RunningChanges | null, task: RunningActivity) => result !== null && result.sessionId === task.sessionId && result.startedAt >= task.since && result.fileCount > 0;
  const remember = (task: RunningActivity, summary: RunningChanges | null) => {
    const key = taskKey(task); cache.delete(key);
    if (summary) cache.set(key, summary);
    while (cache.size > 32) cache.delete(cache.keys().next().value!);
  };
  async function poll(version: number, task: RunningActivity) {
    try {
      const result = await transport.invoke<RunningChanges | null>('runningChanges', { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
      if (!valid(version)) return;
      const summary = matches(result, task) ? result : null;
      remember(task, summary);
      diagnose(summary ? 'running-visible' : 'running-query-empty');
      emit({ ...view, summary, error: '' });
    } catch { if (valid(version)) { diagnose('running-query-error'); emit({ ...view, error: '' }); } }
    finally { if (valid(version)) timer = setTimeout(() => { timer = undefined; void poll(version, task); }, 1000); }
  }
  return {
    setActivity(next: RunningActivity | null) {
      if (disposed) return;
      activity = next; const version = ++epoch;
      if (timer) clearTimeout(timer); timer = undefined;
      const summary = next ? cache.get(taskKey(next)) ?? null : null;
      emit({ summary, busy: false, error: '' });
      diagnose(next ? next.since > 0 ? 'running-ready' : 'running-identity-missing' : 'running-idle');
      if (next) void poll(version, next);
    },
    async open(): Promise<void> {
      const task = activity, summary = view.summary, version = epoch;
      if (!task || !summary || view.busy || disposed) return;
      const guard = () => { if (!valid(version) || view.summary?.runId !== summary.runId) throw new Error('任务已结束或切换 / Task ended or changed'); };
      emit({ ...view, busy: true, error: '' });
      try {
        // Validate the running task, but open the session's latest-turn mode rather
        // than pinning this captured run as a historical selection.
        const selection = await transport.invoke<{ nonce: string }>('selectTurn', { scope: 'lastTurn', sessionId: task.sessionId, runId: summary.runId, runningSince: task.since, taskId: task.taskId });
        guard(); await adapter.open(task.sessionId, `diff-view:${selection.nonce}`, guard); guard();
      } catch (error) {
        if (valid(version) && view.summary?.runId === summary.runId) {
          if (['RUN_NOT_FOUND', 'RUN_MISSING', 'TASK_REQUIRED'].includes(String((error as { code?: string }).code))) {
            remember(task, null); emit({ summary: null, busy: false, error: '' });
          } else { diagnose('running-click-error'); emit({ ...view, error: String((error as Error).message ?? error) }); }
        }
      }
      finally { if (valid(version)) emit({ ...view, busy: false }); }
    },
    dispose() { disposed = true; epoch++; if (timer) clearTimeout(timer); timer = undefined; activity = null; view = { summary: null, busy: false, error: '' }; }
  };
}
