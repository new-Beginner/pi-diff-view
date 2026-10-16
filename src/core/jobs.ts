import { randomUUID } from 'node:crypto';
import { fail } from './path-policy';
type Job = { state: 'pending' | 'done' | 'error'; result?: unknown; error?: { code: string; message: string }; at: number; navigation?: boolean; systemOpen?: boolean };
/** Every bridge request stays short even when Git needs many subprocesses. */
export class JobQueue {
  private jobs = new Map<string, Job>(); private tail = Promise.resolve(); private closed = false;
  constructor(private execute: (method: string, args: unknown) => Promise<unknown>) {}
  admit(method: string, args: unknown, queueIfBusy = false): { jobId: string } | { state: 'busy' } {
    try { return this.start(method, args); }
    catch (error) {
      // No job exists on JOB_BUSY. Only explicit ordinary callers may wait for admission.
      if (queueIfBusy && !['selectTurn', 'openSystemFile'].includes(method) && (error as { code?: string }).code === 'JOB_BUSY') return { state: 'busy' };
      throw error;
    }
  }
  start(method: string, args: unknown): { jobId: string } {
    if (this.closed) fail('PLUGIN_UNLOADED', 'Diff view is closed');
    if (!['sessionEvidence', 'gitManage', 'sessionContext', 'bootstrap', 'review', 'action', 'batchAction', 'copyPatch', 'clearHistory', 'turnSummary', 'runningChanges', 'selectTurn', 'openSystemFile', 'card', 'replyCards'].includes(method)) fail('JOB_DENIED', 'This method is not a background operation');
    const navigation = method === 'selectTurn', systemOpen = method === 'openSystemFile';
    if ([...this.jobs.values()].filter(j => j.state === 'pending' && !!j.navigation === navigation && !!j.systemOpen === systemOpen).length >= (navigation || systemOpen ? 1 : 4)) fail('JOB_BUSY', 'Too many pending review operations');
    for (const [id, j] of this.jobs) if (j.state !== 'pending' && (Date.now() - j.at > 60000 || this.jobs.size > 8)) this.jobs.delete(id);
    const id = randomUUID(), job: Job = { state: 'pending', at: Date.now(), ...(navigation ? { navigation: true } : {}), ...(systemOpen ? { systemOpen: true } : {}) }; this.jobs.set(id, job);
    const work = async () => {
      await new Promise(r => setTimeout(r, 0));
      if (this.closed) return;
      try { const result = await this.execute(method, args); if (!this.closed) { job.result = result ?? null; job.state = 'done'; job.at = Date.now(); } }
      catch (e) { if (!this.closed) { job.error = { code: String((e as any).code ?? 'REVIEW_FAILED'), message: String((e as Error).message) }; job.state = 'error'; job.at = Date.now(); } }
    };
    // Git management already has bounded reads and exclusive writes in schedule()/dispatch().
    // Do not serialize it again behind session history or other independent Git reads.
    const savedRead = method === 'replyCards' || (method === 'review' && (args as { scope?: string })?.scope === 'turn');
    if (navigation || systemOpen || method === 'gitManage' || savedRead) void work(); else this.tail = this.tail.then(work);
    return { jobId: id };
  }
  poll(id: string): Job { const j = this.jobs.get(id); if (!j || this.closed) fail('JOB_EXPIRED', 'Review operation expired'); return { ...j }; }
  async wait(id: string, milliseconds: number): Promise<Job> {
    const end = Date.now() + Math.max(0, Math.min(40, milliseconds));
    while (this.poll(id).state === 'pending' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2));
    return this.poll(id);
  }
  close(): void { this.closed = true; this.jobs.clear(); }
}
