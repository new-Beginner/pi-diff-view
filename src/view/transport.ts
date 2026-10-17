import type { UiTransport } from '../core/contracts';

// A bounded burst avoids imposing 160ms on every step of a cold open.
// Never exceed six short requests in a rolling second (including polls/diagnostics).
const realm = globalThis as typeof globalThis & { __piDiffBurstQueue?: { tail: Promise<unknown>; navigationTail?: Promise<unknown>; mutationTail?: Promise<unknown>; gitTail?: Promise<unknown>; starts: number[] } };
const queue: NonNullable<typeof realm.__piDiffBurstQueue> = realm.__piDiffBurstQueue ??= { tail: Promise.resolve(), starts: [] };
const background = new Set(['sessionEvidence', 'gitManage', 'sessionContext', 'captureMaintenance', 'bootstrap', 'review', 'action', 'batchAction', 'copyPatch', 'clearHistory', 'turnSummary', 'runningChanges', 'selectTurn', 'openSystemFile', 'card', 'replyCards']);
const reads = new Set(['bootstrap', 'review', 'reviewFiles', 'turnSummary', 'runningChanges', 'file', 'comments', 'feedback', 'replyCards', 'rendererReport', 'nativeProbeInfo']);
const gitReads = new Set(['status', 'branches', 'history', 'stashList', 'diff', 'stats', 'commitFiles', 'commitDiff', 'blame', 'stashShow', 'discardPreview']);
const navigationMethods = new Set(['openSystemFile', 'activeReviewSession', 'readTurnSelection', 'selectTurn', 'reviewSurface']);
interface JobResult<T> { state: 'pending' | 'done' | 'error'; result?: T; error?: { code: string; message: string } }
const sessionReadInvalidators = new WeakMap<UiTransport['invoke'], (sessionId: string) => void>();
export function invalidateSessionReads(transport: UiTransport, sessionId: string): void {
  if (sessionId) sessionReadInvalidators.get(transport.invoke)?.(sessionId);
}
export function boundedTransport(invoke: UiTransport['invoke']): UiTransport {
  const wire = <T,>(method: string, args?: unknown, navigation = navigationMethods.has(method)): Promise<T> => {
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
    if (!navigation) queue.tail = admission;
    return request;
  };
  const call = async <T,>(method: string, args?: unknown): Promise<T> => {
    if (!background.has(method)) return wire<T>(method, args);
    const navigation = method === 'selectTurn' || method === 'openSystemFile';
    const admissionDeadline = Date.now() + 30000;
    let started: { jobId?: string; state?: 'pending' | 'done' | 'error' | 'busy'; result?: T; error?: { code: string; message: string } };
    do {
      started = await wire('jobStart', { method, args, waitMs: 40, queueIfBusy: !navigation }, navigation);
      if (started.state !== 'busy') break;
      if (Date.now() >= admissionDeadline) throw new Error('后台任务繁忙，尚未执行本次操作，请稍后重试。');
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (true);
    if (started.state === 'done') return started.result as T;
    if (started.state === 'error') throw Object.assign(new Error(started.error?.message ?? 'Review failed'), { code: started.error?.code });
    if (!started.jobId) throw new Error('Invalid background operation response');
    const deadline = Date.now() + 120000;
    // Git process startup is rarely below 100ms on Windows. Avoid spending all six
    // admissions on premature polls when two independent reads are pending.
    let delay = method === 'gitManage' ? 120 : 40;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const job = await wire<JobResult<T>>('jobPoll', { jobId: started.jobId }, navigation);
      if (job.state === 'done') return job.result as T;
      if (job.state === 'error') throw Object.assign(new Error(job.error?.message ?? 'Review failed'), { code: job.error?.code });
      delay = Math.min(300, delay * 2);
    }
    throw new Error('Background operation is still running. Refresh to check the result; it was not retried.');
  };
  const request = <T,>(method: string, args?: unknown): Promise<T> => {
    if (navigationMethods.has(method)) return call<T>(method, args);
    // Saved history is immutable/read-only while sync runs. Backend still validates ownership.
    const savedRead = method === 'replyCards' || (method === 'review' && (args as { scope?: string; retrySync?: boolean })?.scope === 'turn' && !(args as { retrySync?: boolean }).retrySync)
      || (['file', 'reviewFiles'].includes(method) && String((args as { reviewId?: string })?.reviewId ?? '').startsWith('saved:'));
    if (savedRead) return call<T>(method, args);
    const read = reads.has(method) || (method === 'gitManage' && gitReads.has((args as { operation?: string } | undefined)?.operation ?? ''));
    const repository = method === 'gitManage' || method === 'action' || method === 'batchAction';
    const lane = repository ? 'gitTail' : 'mutationTail';
    const dependencies = [queue[lane] ?? Promise.resolve()];
    if (method === 'clearHistory' || (method === 'review' && !['turn', 'lastTurn'].includes((args as { scope?: string } | undefined)?.scope ?? ''))) dependencies.push(queue.gitTail ?? Promise.resolve());
    const result = Promise.all(dependencies.map(task => task.catch(() => undefined))).then(() => call<T>(method, args));
    // Serialize complete writes within their domain; long Git jobs never fence unrelated UI reads.
    if (!read) queue[lane] = result.then(() => undefined, () => undefined);
    return result;
  };
  const pendingReads = new Map<string, { sessionId?: string; result: Promise<unknown> }>(); let readEpoch = 0;
  const transport: UiTransport = { invoke<T>(method: string, args?: unknown): Promise<T> {
    const read = ['bootstrap', 'review', 'turnSummary', 'runningChanges', 'card', 'replyCards'].includes(method)
      || (method === 'gitManage' && gitReads.has((args as { operation?: string })?.operation ?? ''));
    if (!read) { if (!reads.has(method) && !['reviewSurface', 'readTurnSelection'].includes(method)) readEpoch++; return request<T>(method, args); }
    const key = JSON.stringify([readEpoch, method, args]);
    const previous = pendingReads.get(key); if (previous) return previous.result as Promise<T>;
    const result = request<T>(method, args).finally(() => { if (pendingReads.get(key)?.result === result) pendingReads.delete(key); });
    pendingReads.set(key, { sessionId: (args as { sessionId?: string })?.sessionId, result }); return result;
  } };
  // Detach stale readers, not their backend jobs or any writes. A reactivated
  // view must not coalesce onto a read captured before it left the session.
  sessionReadInvalidators.set(transport.invoke, sessionId => {
    for (const [key, read] of pendingReads) if (read.sessionId === sessionId) pendingReads.delete(key);
  });
  return transport;
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
