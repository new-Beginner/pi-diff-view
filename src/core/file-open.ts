import { randomUUID } from 'node:crypto';
import { fail } from './path-policy';
export interface FileOpenTarget { sessionId: string; path: string }
export interface FileOpenRequest extends FileOpenTarget { requestId: string }
interface FileOpenStatus { state: 'pending' | 'done' | 'error'; error?: string }
interface Listener { id: string; finish(targets: FileOpenRequest[]): void }
/** Ephemeral navigation. A bounded long-poll wakes immediately on an explicit click. */
export class FileOpenRequests {
  private requests = new Map<string, { target: FileOpenRequest; at: number; delivered: boolean; status: FileOpenStatus }>();
  private listeners = new Map<string, Listener>();
  private acknowledgements = new Map<string, Set<() => void>>();
  constructor(private now = Date.now) {}
  add(target: FileOpenTarget): { requestId: string } {
    for (const [id, request] of this.requests) if (this.now() - request.at > 15000) this.requests.delete(id);
    if (this.requests.size >= 16) fail('FILE_OPEN_BUSY', '打开请求过多，请稍后重试。');
    const requestId = randomUUID();
    this.requests.set(requestId, { target: { ...target, requestId }, at: this.now(), delivered: false, status: { state: 'pending' } });
    this.listeners.get(target.sessionId)?.finish(this.take(target.sessionId));
    return { requestId };
  }
  take(sessionId: string): FileOpenRequest[] {
    const targets: FileOpenRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.target.sessionId !== sessionId || request.delivered || request.status.state !== 'pending' || this.now() - request.at > 10000) continue;
      request.delivered = true; targets.push(request.target);
    }
    return targets;
  }
  listen(sessionId: string, listenerId: string): Promise<FileOpenRequest[]> {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\0\r\n]/.test(sessionId) || typeof listenerId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(listenerId)) fail('FILE_OPEN_INVALID', 'Invalid file navigation listener');
    this.listeners.get(sessionId)?.finish([]);
    if (this.listeners.size >= 16) fail('FILE_OPEN_BUSY', 'Too many file navigation listeners');
    const targets = this.take(sessionId);
    if (targets.length) return Promise.resolve(targets);
    return new Promise(resolve => {
      const listener: Listener = { id: listenerId, finish: targets => {
        clearTimeout(timer);
        if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId);
        resolve(targets);
      } };
      const timer = setTimeout(() => listener.finish([]), 1500);
      this.listeners.set(sessionId, listener);
    });
  }
  cancelListen(sessionId: string, listenerId: string) {
    const listener = this.listeners.get(sessionId);
    if (listener?.id === listenerId) listener.finish([]);
    return { ok: true };
  }
  status(requestId: string): FileOpenStatus {
    const request = this.requests.get(requestId);
    if (!request) fail('FILE_OPEN_MISSING', '文件打开请求已失效，请重试。');
    if (request.status.state === 'pending' && this.now() - request.at > 10000) request.status = { state: 'error', error: '文件管理器没有响应，请确认 renderer 扩展已启用后重试。' };
    return request.status;
  }
  async waitStatus(requestId: string): Promise<FileOpenStatus> {
    const status = this.status(requestId);
    if (status.state !== 'pending') return status;
    await new Promise<void>(resolve => {
      const waiters = this.acknowledgements.get(requestId) ?? new Set<() => void>();
      const finish = () => { clearTimeout(timer); waiters.delete(finish); if (!waiters.size) this.acknowledgements.delete(requestId); resolve(); };
      const timer = setTimeout(finish, 1500);
      waiters.add(finish); this.acknowledgements.set(requestId, waiters);
    });
    return this.status(requestId);
  }
  complete(requestId: string, sessionId: string, error?: string) {
    const request = this.requests.get(requestId);
    if (!request || request.target.sessionId !== sessionId || !request.delivered || this.status(requestId).state !== 'pending') fail('FILE_OPEN_MISSING', '文件打开请求已失效。');
    request.status = error ? { state: 'error', error: error.slice(0, 500) } : { state: 'done' };
    for (const finish of this.acknowledgements.get(requestId) ?? []) finish();
    return { ok: true };
  }
  clear() {
    for (const listener of this.listeners.values()) listener.finish([]);
    for (const request of this.requests.values()) request.status = { state: 'error', error: '文件打开请求已取消。' };
    for (const waiters of this.acknowledgements.values()) for (const finish of waiters) finish();
    this.requests.clear();
  }
}
