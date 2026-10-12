import type { RunningChanges, UiTransport } from '../core/contracts';
import type { PluginReviewAdapter, RunningActivity } from './plugin-review-adapter';
export interface RunningView { summary: RunningChanges | null; busy: boolean; error: string }
/** Epochs invalidate every async path, including a switch away and back to the same task. */
export function createRunningChangesController(transport: UiTransport, adapter: PluginReviewAdapter, publish: (view: RunningView) => void, report: (stage: string) => void = () => {}) {
  let activity: RunningActivity | null = null, epoch = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: RunningView = { summary: null, busy: false, error: '' };
  let lastDiagnostic = '';
  const diagnose = (stage: string) => { if (stage !== lastDiagnostic) { lastDiagnostic = stage; report(stage); } };
  const emit = (next: RunningView) => { view = next; if (!disposed) publish(view); };
  const valid = (version: number) => !disposed && epoch === version && activity !== null;
  const matches = (result: RunningChanges | null, task: RunningActivity) => result !== null && result.sessionId === task.sessionId && result.startedAt >= task.since && result.fileCount > 0;
  async function poll(version: number, task: RunningActivity) {
    try {
      const result = await transport.invoke<RunningChanges | null>('runningChanges', { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
      if (!valid(version)) return;
      const summary = matches(result, task) ? result : null;
      diagnose(summary ? 'running-visible' : 'running-query-empty');
      emit({ ...view, summary, error: '' });
    } catch { if (valid(version)) { diagnose('running-query-error'); emit({ summary: null, busy: false, error: '' }); } }
    finally { if (valid(version)) timer = setTimeout(() => { timer = undefined; void poll(version, task); }, 1000); }
  }
  return {
    setActivity(next: RunningActivity | null) {
      if (disposed) return;
      activity = next; const version = ++epoch;
      if (timer) clearTimeout(timer); timer = undefined;
      emit({ summary: null, busy: false, error: '' });
      diagnose(next ? next.since > 0 ? 'running-ready' : 'running-identity-missing' : 'running-idle');
      if (next) void poll(version, next);
    },
    async open(): Promise<void> {
      const task = activity, summary = view.summary, version = epoch;
      if (!task || !summary || view.busy || disposed) return;
      const guard = () => { if (!valid(version) || view.summary?.runId !== summary.runId) throw new Error('任务已结束或切换 / Task ended or changed'); };
      emit({ ...view, busy: true, error: '' });
      try {
        const result = await transport.invoke<RunningChanges | null>('runningChanges', { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
        guard();
        if (!matches(result, task) || result!.runId !== summary.runId) { emit({ summary: null, busy: false, error: '' }); return; }
        await transport.invoke('activeReviewSession', { sessionId: task.sessionId }); guard();
        const selection = await transport.invoke<{ nonce: string }>('selectTurn', { sessionId: task.sessionId, runId: summary.runId, runningSince: task.since, taskId: task.taskId });
        guard(); await adapter.open(task.sessionId, `diff-view:${selection.nonce}`, guard); guard();
      } catch (error) { if (valid(version) && view.summary?.runId === summary.runId) { diagnose('running-click-error'); emit({ ...view, error: String((error as Error).message ?? error) }); } }
      finally { if (valid(version)) emit({ ...view, busy: false }); }
    },
    dispose() { disposed = true; epoch++; if (timer) clearTimeout(timer); timer = undefined; activity = null; view = { summary: null, busy: false, error: '' }; }
  };
}
