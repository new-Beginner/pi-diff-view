import type { UiTransport } from '../core/contracts';

// One short wire request at a time across all UI callers in this JS realm.
const realm = globalThis as typeof globalThis & { __piDiffQueue?: { tail: Promise<unknown>; last: number } };
const queue = realm.__piDiffQueue ??= { tail: Promise.resolve(), last: 0 };
const background = new Set(['bootstrap', 'review', 'action', 'batchAction', 'copyPatch', 'clearHistory', 'turnSummary', 'selectTurn']);
interface JobResult<T> { state: 'pending' | 'done' | 'error'; result?: T; error?: { code: string; message: string } }
export function boundedTransport(invoke: UiTransport['invoke']): UiTransport {
  const wire = <T,>(method: string, args?: unknown): Promise<T> => {
    const bytes = new TextEncoder().encode(JSON.stringify({ method, args })).length;
    if (bytes > 48 * 1024) return Promise.reject(new Error('Request exceeds the bridge payload limit (48 KiB).'));
    if (method === 'saveComment' && bytes > 24000) return Promise.reject(new Error('Comment payload too large; shorten the comment or excerpt.'));
    const request = queue.tail.catch(() => undefined).then(async () => {
      const wait = 160 - (Date.now() - queue.last);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      queue.last = Date.now();
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
    queue.tail = request;
    return request;
  };
  return { async invoke<T>(method: string, args?: unknown): Promise<T> {
    if (!background.has(method)) return wire<T>(method, args);
    const { jobId } = await wire<{ jobId: string }>('jobStart', { method, args });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const job = await wire<JobResult<T>>('jobPoll', { jobId });
      if (job.state === 'done') return job.result as T;
      if (job.state === 'error') throw Object.assign(new Error(job.error?.message ?? 'Review failed'), { code: job.error?.code });
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
