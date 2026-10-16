import { fail } from './path-policy';
import { surfaceStamp, type SurfaceRequest, type SurfaceReply } from './review-surface-protocol';
export { surfaceStamp, type SurfaceRequest, type SurfaceReply } from './review-surface-protocol';
type Lease = SurfaceRequest & { at: number; version: number; locatingAt?: number; ack?: string };
/** Plugin-owned transient pairing, never a global "last selected session" fallback.
 * No public window identity exists: more than one live renderer/view fails closed.
 */
export class ReviewSurfaces {
  private leases = new Map<string, Lease>();
  private revision = 0;
  private waiters = new Set<() => void>();
  private notify() { for (const wake of [...this.waiters]) wake(); }
  async request(args: SurfaceRequest): Promise<SurfaceReply> {
    if (args?.after != null && (typeof args.after !== 'string' || args.after.length > 1024)) fail('NAVIGATION_INVALID', 'Invalid surface cursor');
    if (args?.waitMs != null && (!Number.isFinite(args.waitMs) || args.waitMs < 0 || args.waitMs > 1000)) fail('NAVIGATION_INVALID', 'Invalid surface wait');
    const reply = this.exchange(args);
    if (!args.waitMs || args.release || reply.state === 'stale' || args.after !== surfaceStamp(reply)) return reply;
    return new Promise(resolve => {
      const finish = (value: SurfaceReply) => { clearTimeout(timer); this.waiters.delete(wake); resolve(value); };
      const wake = (timeout = false) => {
        const lease = this.leases.get(`${args.role}:${args.id}`);
        const value: SurfaceReply = lease && lease.seq !== args.seq ? { state: 'stale', sessionId: null } : this.snapshot();
        if (timeout || surfaceStamp(value) !== args.after) finish(value);
      };
      const timer = setTimeout(() => wake(true), args.waitMs);
      this.waiters.add(wake);
    });
  }
  constructor(private now = Date.now) {}
  exchange(args: SurfaceRequest): SurfaceReply {
    if (!args || !['renderer', 'view'].includes(args.role) || typeof args.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.id) || !Number.isSafeInteger(args.seq) || args.seq < 1) fail('NAVIGATION_INVALID', 'Invalid surface identity');
    if (args.sessionId != null && (typeof args.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.sessionId))) fail('NAVIGATION_INVALID', 'Invalid surface session');
    if (args.nonce != null && (typeof args.nonce !== 'string' || args.nonce.length > 80 || !Number.isSafeInteger(args.selectionRevision) || args.selectionRevision! < 1)) fail('NAVIGATION_INVALID', 'Invalid surface selection');
    if (args.sessionEpoch != null && (!Number.isSafeInteger(args.sessionEpoch) || args.sessionEpoch < 0)) fail('NAVIGATION_INVALID', 'Invalid session epoch');
    const now = this.now();
    for (const [key, value] of this.leases) if (now - value.at > 15000) this.leases.delete(key);
    const id = `${args.role}:${args.id}`, old = this.leases.get(id);
    if (old && args.seq <= old.seq) return { state: 'stale', sessionId: null };
    if (args.release) { this.leases.delete(id); this.notify(); return { state: 'waiting', sessionId: null }; }
    if (!old && this.leases.size >= 32) fail('NAVIGATION_BUSY', 'Too many active review instances');
    let value: Lease;
    if (args.role === 'renderer') {
      const sessionId = args.sessionId ?? null;
      const sessionEpoch = args.sessionEpoch ?? 0;
      if (old && sessionEpoch < (old.sessionEpoch ?? 0)) return { state: 'stale', sessionId: null };
      const changed = !old || old.sessionId !== sessionId || old.sessionEpoch !== sessionEpoch;
      value = { ...old, role: args.role, id: args.id, seq: args.seq, sessionId, sessionEpoch, at: now, version: old?.version ?? ++this.revision };
      if (changed) { value.nonce = undefined; value.selectionRevision = undefined; value.locatingAt = undefined; value.version = ++this.revision; }
      if (args.locating === true) { value.nonce = undefined; value.selectionRevision = undefined; value.locatingAt = now; value.version = ++this.revision; }
      if (args.locating === false) value.locatingAt = undefined;
      if (args.nonce != null) { value.nonce = args.nonce; value.selectionRevision = args.selectionRevision; value.locatingAt = undefined; value.version = ++this.revision; }
    } else value = { ...old, role: args.role, id: args.id, seq: args.seq, ack: args.ack, at: now, version: 0 };
    this.leases.set(id, value);
    this.notify();
    return this.snapshot();
  }
  private snapshot(): SurfaceReply {
    for (const [key, value] of this.leases) if (this.now() - value.at > 15000) this.leases.delete(key);
    const renderers = [...this.leases.values()].filter(row => row.role === 'renderer');
    const views = [...this.leases.values()].filter(row => row.role === 'view');
    if (renderers.length > 1 || views.length > 1) return { state: 'ambiguous', sessionId: null };
    if (renderers.length !== 1) return { state: 'waiting', sessionId: null };
    const renderer = renderers[0];
    // Renderer may publish before the launcher creates the view.
    const key = `${renderer.id}:${renderer.version}:${views[0]?.id ?? ''}`;
    return { state: 'ready', sessionId: renderer.sessionId ?? null, key, nonce: renderer.nonce, selectionRevision: renderer.selectionRevision, confirmed: views.length === 1 && views[0].ack === key, locating: renderer.locatingAt != null && this.now() - renderer.locatingAt < 12000 };
  }
  clear() { this.leases.clear(); this.revision++; this.notify(); }
}
