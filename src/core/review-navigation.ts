import { randomUUID } from 'node:crypto';
import type { ReviewRequest } from './contracts';
import { fail } from './path-policy';
export interface ReviewNavigation { nonce: string; revision: number; sessionId: string; request: ReviewRequest; fileId?: string; at: number; }
/** Persistable selections; request-time session identity, not a process-global window, guards reads. */
export class ReviewNavigationStore {
  private activeSession: string | null | undefined;
  private selections = new Map<string, ReviewNavigation>();
  setActiveSession(sessionId: string | null) { this.activeSession = sessionId; }
  set(request: ReviewRequest, fileId?: string): ReviewNavigation {
    if (!request.sessionId || (request.scope !== 'lastTurn' && (request.scope !== 'turn' || !request.runId))) fail('NAVIGATION_INVALID', 'A recorded task/session is required');
    if (request.scope === 'lastTurn' && (request.runId != null || request.root != null || fileId != null)) fail('NAVIGATION_INVALID', 'Latest turn cannot pin a recorded task, project or file');
    const previous = this.selections.get(request.sessionId);
    const entry = { nonce: previous?.nonce ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, sessionId: request.sessionId, request, fileId, at: Date.now() };
    this.selections.set(request.sessionId, entry);
    return entry;
  }
  get(nonce: string, sessionId?: string | null): ReviewNavigation | null {
    const expected = sessionId === undefined ? this.activeSession : sessionId;
    return [...this.selections.values()].find(entry => entry.nonce === nonce && (expected === undefined || entry.sessionId === expected)) ?? null;
  }
  export(): ReviewNavigation[] { return [...this.selections.values()]; }
  restore(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || !/^[0-9a-f-]{36}$/i.test(entry.nonce) || typeof entry.sessionId !== 'string' || !entry.sessionId || entry.request?.sessionId !== entry.sessionId || !Number.isSafeInteger(entry.revision)) continue;
      if (entry.request.scope === 'lastTurn') {
        if (entry.request.runId != null || entry.request.root != null || entry.fileId != null) continue;
      } else if (entry.request.scope !== 'turn' || !/^[a-zA-Z0-9-]{1,80}$/.test(entry.request.runId)) continue;
      this.selections.set(entry.sessionId, entry);
    }
  }
  clear() { this.selections.clear(); this.activeSession = undefined; }
}
