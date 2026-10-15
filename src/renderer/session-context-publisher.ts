import { evidenceChunks } from '../core/host-transcript';
import type { UiTransport } from '../core/contracts';
import type { SessionContext } from './plugin-review-adapter';

const retryDelays = [500, 1000, 2000] as const;
interface Pending { context: SessionContext; failures: number }
/** Latest-only, single-flight publisher. A failed context stays pending until replaced. */
export function createSessionContextPublisher(options: {
  transport: UiTransport;
  isCurrent(): boolean;
  wake(): void;
  report(): void;
}) {
  let sessionId: string | null | undefined, generation = 0, disposed = false, publishing = false;
  let pending: Pending | undefined, uploaded: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !disposed && options.isCurrent();
  const cancelRetry = () => { if (retryTimer !== undefined) clearTimeout(retryTimer); retryTimer = undefined; };
  const publish = async () => {
    if (publishing || !alive()) return;
    publishing = true;
    try {
      while (pending && alive()) {
        const work = pending, version = generation;
        const currentSession = () => alive() && generation === version;
        const latest = () => currentSession() && pending === work;
        try {
          const { evidence, ...metadata } = work.context;
          const key = JSON.stringify([metadata.sessionId, metadata.root, metadata.evidenceRevision]);
          if (evidence && key !== uploaded) {
            if (new TextEncoder().encode(evidence).length > 8 * 1024 * 1024) throw new Error('Host evidence exceeds 8 MiB');
            const chunks = evidenceChunks(evidence);
            // Each attempt starts at zero: a partial upload cannot be resumed safely.
            for (const [index, chunk] of chunks.entries()) {
              if (!latest()) break;
              await options.transport.invoke('sessionEvidence', { sessionId: metadata.sessionId, root: metadata.root, revision: metadata.evidenceRevision, index, chunk, final: index === chunks.length - 1 });
              if (!currentSession()) break;
              // A newer context in this session can reuse a fully confirmed upload.
              if (index === chunks.length - 1) uploaded = key;
            }
          }
          if (!latest()) continue;
          const result = await options.transport.invoke<{ ok?: boolean } | undefined>('sessionContext', metadata);
          if (!latest()) continue;
          if (result?.ok === false) throw new Error('Session context was not accepted');
          pending = undefined;
          options.wake();
        } catch {
          if (!latest()) continue;
          options.report();
          const delay = retryDelays[work.failures++];
          if (delay !== undefined) retryTimer = setTimeout(() => { retryTimer = undefined; void publish(); }, delay);
          // After three retries, retain the latest context but wait for a new update.
          return;
        }
      }
    } finally { publishing = false; }
  };
  return {
    update(nextSessionId: string | null, context?: SessionContext) {
      if (!alive()) return;
      if (sessionId !== nextSessionId) {
        sessionId = nextSessionId; generation++; pending = undefined; cancelRetry();
      }
      if (!context || !nextSessionId || context.sessionId !== nextSessionId) return;
      cancelRetry();
      pending = { context: { ...context }, failures: 0 };
      void publish();
    },
    dispose() {
      disposed = true; generation++; pending = undefined; uploaded = undefined; cancelRetry();
    }
  };
}
