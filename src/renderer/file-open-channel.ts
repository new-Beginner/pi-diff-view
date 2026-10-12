import type { UiTransport } from '../core/contracts';
import type { FileOpenRequest } from '../core/file-open';
/** One active-session listener; no history queries and no fixed click-to-open delay. */
export function startFileOpenChannel(transport: UiTransport, sessionId: string, open: (sessionId: string, path: string, guard: () => void) => Promise<void>, isCurrent: () => boolean): () => void {
  const listenerId = crypto.randomUUID();
  let stopped = false, retryTimer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !stopped && isCurrent();
  const receive = async () => {
    while (alive()) {
      try {
        const requests = await transport.invoke<FileOpenRequest[]>('openFile', { listen: true, sessionId, listenerId });
        if (!alive()) return;
        if (!Array.isArray(requests)) throw new Error('Invalid file navigation response');
        for (const request of requests) {
          if (!alive()) return;
          let error: string | undefined;
          try {
            if (request.sessionId !== sessionId) throw new Error('File navigation session changed');
            await open(sessionId, request.path, () => { if (!alive()) throw new Error('File navigation session changed'); });
          } catch (reason) { error = String((reason as Error)?.message ?? reason); }
          if (!alive()) return;
          await transport.invoke('openFile', { requestId: request.requestId, sessionId, complete: true, error });
        }
      } catch {
        if (alive()) retryTimer = setTimeout(() => { retryTimer = undefined; void receive(); }, 1000);
        return; // Recover transport failures only; never replay a delivered navigation.
      }
    }
  };
  void receive();
  return () => {
    if (stopped) return;
    stopped = true; if (retryTimer) clearTimeout(retryTimer);
    void transport.invoke('openFile', { cancelListen: listenerId, sessionId }).catch(() => {});
  };
}
