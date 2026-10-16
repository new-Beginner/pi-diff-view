import type { UiTransport } from '../core/contracts';
import type { SurfaceReply } from '../core/review-surfaces';
import type { ReviewNavigation } from '../core/review-navigation';
import type { ReviewNavigationChannel } from './plugin-review-adapter';
/** Single renderer identity, monotonic updates and no automatic replay of navigation. */
export function createReviewSurfaceClient(transport: UiTransport) {
  const id = crypto.randomUUID();
  let seq = 0, sessionId: string | null = null, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0, pending = false;
  const exchange = (extra = {}) => transport.invoke<SurfaceReply>('reviewSurface', { role: 'renderer', id, seq: ++seq, sessionId, ...extra });
  const heartbeat = async () => {
    if (closed || pending) return;
    pending = true; const stamp = version;
    try { await exchange(); } catch { /* The next lease refresh is bounded by the timer. */ }
    finally { pending = false; if (!closed) { if (stamp !== version) void heartbeat(); else timer = setTimeout(() => void heartbeat(), 2000); } }
  };
  const channel: ReviewNavigationChannel = {
    async prepare(target, location, guard) {
      guard(); if (closed || target !== sessionId) throw new Error('会话已切换 / Session changed');
      const stamp = version;
      const selected = await transport.invoke<ReviewNavigation>('readTurnSelection', { sessionId: target, nonce: location.slice('diff-view:'.length) });
      guard(); if (closed || stamp !== version || selected.sessionId !== target) throw new Error('会话已切换 / Session changed');
      const reply = await exchange({ nonce: selected.nonce, selectionRevision: selected.revision });
      guard();
      if (reply.state !== 'ready' || reply.sessionId !== target) throw new Error('存在多个窗口或审查视图，无法唯一定位；请只保留一个窗口和审查视图。');
      return { stamp, nonce: selected.nonce, revision: selected.revision };
    },
    async confirm(value, guard) {
      const ticket = value as { stamp: number; nonce: string; revision: number };
      const deadline = Date.now() + 12000;
      do {
        guard(); if (closed || version !== ticket.stamp) throw new Error('会话已切换 / Session changed');
        const reply = await exchange(); guard();
        if (reply.state === 'ambiguous') throw new Error('存在多个窗口或审查视图，已停止定位。');
        if (reply.nonce !== ticket.nonce || reply.selectionRevision !== ticket.revision) throw new Error('文件选择已变化，请重新点击。');
        if (reply.confirmed) return;
        await new Promise(resolve => setTimeout(resolve, 400));
      } while (Date.now() < deadline);
      throw new Error('审查页签未确认文件定位，请重试；未自动重放打开请求。');
    }
  };
  return {
    channel,
    update(next: string | null) { if (closed) return; if (next !== sessionId) { sessionId = next; version++; } if (timer) clearTimeout(timer); void heartbeat(); },
    dispose() { closed = true; version++; if (timer) clearTimeout(timer); void exchange({ release: true }).catch(() => {}); }
  };
}
