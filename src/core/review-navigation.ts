import { randomUUID } from 'node:crypto';
import type { ReviewRequest } from './contracts';
import { fail } from './path-policy';
export interface ReviewNavigation { nonce: string; sessionId: string; request: ReviewRequest; fileId?: string; at: number; }
/** Plugin-owned volatile UI selections only, never transcript/database edits. */
export class ReviewNavigationStore {
  private activeSession: string | null | undefined;
  setActiveSession(sessionId: string | null) { this.activeSession = sessionId; }
  private selections = new Map<string, ReviewNavigation>();
  set(request: ReviewRequest, fileId?: string): ReviewNavigation {
    if (!request.sessionId || request.scope !== 'turn' || !request.runId) fail('NAVIGATION_INVALID', 'A recorded task/session is required');
    this.prune();
    const entry = { nonce: randomUUID(), sessionId: request.sessionId, request, fileId, at: Date.now() };
    this.selections.delete(request.sessionId); this.selections.set(request.sessionId, entry);
    while (this.selections.size > 32) this.selections.delete(this.selections.keys().next().value!);
    return entry;
  }
  get(nonce: string): ReviewNavigation | null { this.prune(); return [...this.selections.values()].find(entry => entry.nonce === nonce && (this.activeSession === undefined || entry.sessionId === this.activeSession)) ?? null; }
  clear() { this.selections.clear(); this.activeSession = undefined; }
  private prune() { for (const [key, value] of this.selections) if (Date.now() - value.at > 30 * 60 * 1000) this.selections.delete(key); }
}
