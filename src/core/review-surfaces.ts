import { fail } from './path-policy';
export interface SurfaceRequest {
  role: 'renderer' | 'view'; id: string; seq: number; release?: boolean;
  sessionId?: string | null; nonce?: string; selectionRevision?: number; ack?: string;
}
export interface SurfaceReply {
  state: 'ready' | 'waiting' | 'ambiguous' | 'stale'; sessionId: string | null;
  key?: string; nonce?: string; selectionRevision?: number; confirmed?: boolean;
}
type Lease = SurfaceRequest & { at: number; version: number; ack?: string };
/** Plugin-owned transient pairing, never a global "last selected session" fallback.
 * No public window identity exists: more than one live renderer/view fails closed.
 */
export class ReviewSurfaces {
  private leases = new Map<string, Lease>();
  private revision = 0;
  constructor(private now = Date.now) {}
  exchange(args: SurfaceRequest): SurfaceReply {
    if (!args || !['renderer', 'view'].includes(args.role) || typeof args.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.id) || !Number.isSafeInteger(args.seq) || args.seq < 1) fail('NAVIGATION_INVALID', 'Invalid surface identity');
    if (args.sessionId != null && (typeof args.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId))) fail('NAVIGATION_INVALID', 'Invalid surface session');
    if (args.nonce != null && (typeof args.nonce !== 'string' || args.nonce.length > 80 || !Number.isSafeInteger(args.selectionRevision) || args.selectionRevision! < 1)) fail('NAVIGATION_INVALID', 'Invalid surface selection');
    const now = this.now();
    for (const [key, value] of this.leases) if (now - value.at > 15000) this.leases.delete(key);
    const id = `${args.role}:${args.id}`, old = this.leases.get(id);
    if (old && args.seq <= old.seq) return { state: 'stale', sessionId: null };
    if (args.release) { this.leases.delete(id); return { state: 'waiting', sessionId: null }; }
    if (!old && this.leases.size >= 32) fail('NAVIGATION_BUSY', 'Too many active review instances');
    let value: Lease;
    if (args.role === 'renderer') {
      const sessionId = args.sessionId ?? null;
      const changed = !old || old.sessionId !== sessionId;
      value = { ...old, role: args.role, id: args.id, seq: args.seq, sessionId, at: now, version: old?.version ?? ++this.revision };
      if (changed) { value.nonce = undefined; value.selectionRevision = undefined; value.version = ++this.revision; }
      if (args.nonce != null) { value.nonce = args.nonce; value.selectionRevision = args.selectionRevision; value.version = ++this.revision; }
    } else value = { ...old, role: args.role, id: args.id, seq: args.seq, ack: args.ack, at: now, version: 0 };
    this.leases.set(id, value);
    const renderers = [...this.leases.values()].filter(row => row.role === 'renderer');
    const views = [...this.leases.values()].filter(row => row.role === 'view');
    if (renderers.length > 1 || views.length > 1) return { state: 'ambiguous', sessionId: null };
    if (renderers.length !== 1) return { state: 'waiting', sessionId: null };
    const renderer = renderers[0];
    // Renderer may publish before the launcher creates the view.
    const key = `${renderer.id}:${renderer.version}:${views[0]?.id ?? ''}`;
    return { state: 'ready', sessionId: renderer.sessionId ?? null, key, nonce: renderer.nonce, selectionRevision: renderer.selectionRevision, confirmed: views.length === 1 && views[0].ack === key };
  }
  clear() { this.leases.clear(); this.revision++; }
}
