import type { PublicHostSnapshot } from './public-host-source';
import type { CaptureContext } from './capture-context';
import { collectDelegations } from './delegation-lifecycle';
/** Native turn IDs are diagnostic only; they are never substituted for user IDs. */
export function publicSessionContext(snapshot: PublicHostSnapshot, now = Date.now()): Omit<CaptureContext, 'root'> & { root?: string; turnId?: string } {
  const time = (value: unknown) => { const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0; return Number.isSafeInteger(n) && n > 0 && n <= now ? n : 0; };
  const users = snapshot.messages.filter(m => m.role === 'user' && !m.meta.parentMessageId && !m.meta.steering);
  const children = collectDelegations(snapshot.messages).filter(child => child.status === 'running');
  const candidates = snapshot.running ? users : users.filter(user => children.some(child => child.owner === user.id));
  const user = candidates.at(-1), since = user ? time(user.createdAt) : 0;
  const valid = !!user && /^[a-zA-Z0-9-]{1,256}$/.test(user.id) && since > 0 && !candidates.some(other => other.id !== user.id && time(other.createdAt) === since);
  return {
    sessionId: snapshot.sessionId, root: snapshot.root,
    statusKnown: snapshot.statusKnown, running: snapshot.running || children.length > 0,
    mainRunning: snapshot.statusKnown ? snapshot.running : undefined,
    ...(valid ? { taskId: user.id, since } : {}),
    ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}), updatedAt: now,
  };
}
