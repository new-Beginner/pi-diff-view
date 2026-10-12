import { randomUUID } from 'node:crypto';
import { fail } from './path-policy';
export interface FileOpenTarget { sessionId: string; path: string }
export interface FileOpenRequest extends FileOpenTarget { requestId: string }
/** Ephemeral, session-scoped navigation only. Never persists or modifies files. */
export class FileOpenRequests {
  private requests = new Map<string, { target: FileOpenRequest; at: number; delivered: boolean; state: 'pending' | 'done' | 'error'; error?: string }>();
  constructor(private now = Date.now) {}
  add(target: FileOpenTarget): { requestId: string } {
    for (const [id, request] of this.requests) if (this.now() - request.at > 15000) this.requests.delete(id);
    if (this.requests.size >= 16) fail('FILE_OPEN_BUSY', '打开请求过多，请稍后重试。');
    const requestId = randomUUID();
    this.requests.set(requestId, { target: { ...target, requestId }, at: this.now(), delivered: false, state: 'pending' });
    return { requestId };
  }
  take(sessionId: string): FileOpenRequest[] {
    const targets: FileOpenRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.target.sessionId !== sessionId || request.delivered || request.state !== 'pending' || this.now() - request.at > 10000) continue;
      request.delivered = true; targets.push(request.target);
    }
    return targets;
  }
  status(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) fail('FILE_OPEN_MISSING', '文件打开请求已失效，请重试。');
    if (request.state === 'pending' && this.now() - request.at > 10000) { request.state = 'error'; request.error = '文件管理器没有响应，请确认 renderer 扩展已启用后重试。'; }
    return { state: request.state, error: request.error };
  }
  complete(requestId: string, sessionId: string, error?: string) {
    const request = this.requests.get(requestId);
    if (!request || request.target.sessionId !== sessionId || !request.delivered || this.status(requestId).state !== 'pending') fail('FILE_OPEN_MISSING', '文件打开请求已失效。');
    request.state = error ? 'error' : 'done'; request.error = error?.slice(0, 500);
    return { ok: true };
  }
  clear() { this.requests.clear(); }
}
