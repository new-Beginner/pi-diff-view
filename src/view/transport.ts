import type { UiTransport } from '../core/contracts';

// A bounded burst avoids imposing 160ms on every step of a cold open.
// Never exceed six short requests in a rolling second (including polls/diagnostics).
const realm = globalThis as typeof globalThis & { __piDiffBurstQueue?: { tail: Promise<unknown>; navigationTail?: Promise<unknown>; starts: number[] } };
const queue: NonNullable<typeof realm.__piDiffBurstQueue> = realm.__piDiffBurstQueue ??= { tail: Promise.resolve(), starts: [] };
const background = new Set(['sessionEvidence', 'gitManage', 'sessionContext', 'bootstrap', 'review', 'action', 'batchAction', 'copyPatch', 'clearHistory', 'turnSummary', 'runningChanges', 'selectTurn', 'card', 'replyCards']);
interface JobResult<T> { state: 'pending' | 'done' | 'error'; result?: T; error?: { code: string; message: string } }
export function boundedTransport(invoke: UiTransport['invoke']): UiTransport {
  const wire = <T,>(method: string, args?: unknown, navigation = ['openFile', 'activeReviewSession', 'readTurnSelection', 'selectTurn'].includes(method)): Promise<T> => {
    const bytes = new TextEncoder().encode(JSON.stringify({ method, args })).length;
    if (bytes > 48 * 1024) return Promise.reject(new Error('Request exceeds the bridge payload limit (48 KiB).'));
    if (method === 'saveComment' && bytes > 24000) return Promise.reject(new Error('Comment payload too large; shorten the comment or excerpt.'));
    const admission = (navigation ? queue.navigationTail ?? Promise.resolve() : queue.tail).catch(() => undefined).then(async () => {
      // Admission is serialized, not the long-poll response. Recheck after every wait
      // so concurrent navigation and ordinary traffic still share the six-request cap.
      for (;;) {
        queue.starts = queue.starts.filter(at => Date.now() - at < 1000);
        if (queue.starts.length < 6) { queue.starts.push(Date.now()); break; }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 1001 - (Date.now() - queue.starts[0]))));
      }
    });
    if (navigation) queue.navigationTail = admission;
    const request = admission.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          invoke<T>(method, args),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Bridge request timed out. Refresh to check the result; the operation was not retried.')), 1950); })
        ]);
        if (bytes + new TextEncoder().encode(JSON.stringify(response) ?? '').length > 62 * 1024) throw new Error('Combined request/response exceeds the bridge payload limit.');
        return response;
      } finally { if (timer) clearTimeout(timer); }
    });
    if (!navigation) queue.tail = request;
    return request;
  };
  return { async invoke<T>(method: string, args?: unknown): Promise<T> {
    if (!background.has(method)) return wire<T>(method, args);
    const navigation = method === 'selectTurn';
    const started = await wire<{ jobId: string } & Partial<JobResult<T>>>('jobStart', { method, args, waitMs: 40 }, navigation);
    if (started.state === 'done') return started.result as T;
    if (started.state === 'error') throw Object.assign(new Error(started.error?.message ?? 'Review failed'), { code: started.error?.code });
    const deadline = Date.now() + 120000;
    let delay = 40;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const job = await wire<JobResult<T>>('jobPoll', { jobId: started.jobId }, navigation);
      if (job.state === 'done') return job.result as T;
      if (job.state === 'error') throw Object.assign(new Error(job.error?.message ?? 'Review failed'), { code: job.error?.code });
      delay = Math.min(300, delay * 2);
    }
    throw new Error('Background operation is still running. Refresh to check the result; it was not retried.');
  } };
}
const known = new WeakMap<UiTransport, UiTransport>();
const knownInvokes = new WeakSet<UiTransport['invoke']>();
export function ensureBounded(transport: UiTransport): UiTransport {
  const previous = known.get(transport);
  if (previous) return previous;
  const result = { ...(knownInvokes.has(transport.invoke) ? { invoke: transport.invoke } : boundedTransport(transport.invoke.bind(transport))), insertText: transport.insertText };
  knownInvokes.add(result.invoke);
  known.set(transport, result); known.set(result, result);
  return result;
}
