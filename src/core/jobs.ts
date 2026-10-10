import { randomUUID } from 'node:crypto';
import { fail } from './path-policy';
type Job = { state: 'pending' | 'done' | 'error'; result?: unknown; error?: { code: string; message: string }; at: number };
/** Every bridge request stays short even when Git needs many subprocesses. */
export class JobQueue {
  private jobs = new Map<string, Job>(); private tail = Promise.resolve(); private closed = false;
  constructor(private execute: (method: string, args: unknown) => Promise<unknown>) {}
  start(method: string, args: unknown): { jobId: string } {
    if (this.closed) fail('PLUGIN_UNLOADED', 'Diff view is closed');
    if (!['bootstrap', 'review', 'action', 'batchAction', 'copyPatch', 'clearHistory', 'turnSummary', 'selectTurn'].includes(method)) fail('JOB_DENIED', 'This method is not a background operation');
    if ([...this.jobs.values()].filter(j => j.state === 'pending').length >= 4) fail('JOB_BUSY', 'Too many pending review operations');
    for (const [id, j] of this.jobs) if (j.state !== 'pending' && (Date.now() - j.at > 60000 || this.jobs.size > 8)) this.jobs.delete(id);
    const id = randomUUID(), job: Job = { state: 'pending', at: Date.now() }; this.jobs.set(id, job);
    this.tail = this.tail.then(async () => {
      await new Promise(r => setTimeout(r, 0));
      if (this.closed) return;
      try { const result = await this.execute(method, args); if (!this.closed) { job.result = result ?? null; job.state = 'done'; job.at = Date.now(); } }
      catch (e) { if (!this.closed) { job.error = { code: String((e as any).code ?? 'REVIEW_FAILED'), message: String((e as Error).message) }; job.state = 'error'; job.at = Date.now(); } }
    });
    return { jobId: id };
  }
  poll(id: string): Job { const j = this.jobs.get(id); if (!j || this.closed) fail('JOB_EXPIRED', 'Review operation expired'); return { ...j }; }
  close(): void { this.closed = true; this.jobs.clear(); }
}
