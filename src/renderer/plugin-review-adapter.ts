import { createHostStateAdapter, PluginReviewError } from './host-state-adapter';
import type { RunningActivity, SessionContext } from './host-state-adapter';
export { PluginReviewError, runningActivity, activityDiagnostic } from './host-state-adapter';
export type { RunningActivity, SessionContext } from './host-state-adapter';
export const REVIEW_TAB_ID = 'plugin:local.diff-view/review';
export interface PluginReviewAdapter {
  subscribeSession(listener: (sessionId: string | null, context?: SessionContext) => void): Promise<() => void>;
  subscribeEvidence?(listener: (sessionId: string | null, context?: SessionContext) => void): Promise<() => void>;
  subscribeActivity(listener: (activity: RunningActivity | null) => void, diagnose?: (stage: string) => void): Promise<() => void>;
  reveal?(sessionId: string, guard?: () => void): Promise<void>;
  open(sessionId: string, location: string, guard?: () => void): Promise<void>;
  close(): void;
}
const denied = (code: string, message: string): never => { throw new PluginReviewError(code, message); };
const validId = (value: string | null): value is string => !!value && /^[a-zA-Z0-9-]{1,80}$/.test(value);
/** Read-only host DOM compatibility, independently implemented from the inspected host markup. */
export function domSession(document: Document): string | null {
  const panes = [...document.querySelectorAll('[data-session-pane][data-visible="true"]')];
  const rows = [...document.querySelectorAll('.thread-item.active[data-sidebar-session-row]')];
  if (panes.length > 1 || rows.length > 1) return null;
  const pane = panes[0]?.getAttribute('data-session-pane') ?? null;
  const row = rows[0]?.getAttribute('data-sidebar-session-row') ?? null;
  if ((panes.length && !validId(pane)) || (rows.length && !validId(row)) || (pane && row && pane !== row)) return null;
  return pane ?? row;
}
export interface ReviewNavigationChannel {
  begin?(sessionId: string, guard: () => void): Promise<void>;
  prepare(sessionId: string, location: string, guard: () => void): Promise<unknown>;
  confirm(ticket: unknown, guard: () => void): Promise<void>;
}
export function createPluginReviewAdapter(options: {
  document?: Document; observe?: (callback: () => void) => { disconnect(): void };
  read?: (sessionId: string) => Promise<SessionContext>; navigation?: ReviewNavigationChannel;
} = {}): PluginReviewAdapter {
  let closed = false, opening = false;
  const subscriptions = new Set<() => void>();
  const doc = () => options.document ?? document;
  const observeDom = (document: Document, publish: () => void, invalidate: () => void, current: () => string | null | undefined) => {
    if (options.observe) return options.observe(publish);
    const observer = new MutationObserver(records => {
      // Preserve batched A → B → A invalidation without reacting to unrelated mutations.
      const previous = current();
      const excursion = records.some(record => {
        if (record.type !== 'attributes' || !previous) return false;
        const node = record.target as Element;
        if (['data-session-pane', 'data-sidebar-session-row'].includes(record.attributeName ?? '')) return node.getAttribute(record.attributeName!) === previous && validId(record.oldValue) && record.oldValue !== previous;
        if (record.attributeName === 'data-visible') return node.getAttribute('data-session-pane') === previous && node.getAttribute('data-visible') === 'true' && record.oldValue === 'false';
        return record.attributeName === 'class' && node.getAttribute('data-sidebar-session-row') === previous && node.classList.contains('active') && !record.oldValue?.split(/\s+/).includes('active');
      });
      if (excursion && previous) invalidate();
      publish();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-session-pane', 'data-visible', 'data-sidebar-session-row', 'class'] });
    return observer;
  };
  let invalidating = false;
  const source = createHostStateAdapter({
    read: options.read ?? (async () => denied('SIDEBAR_CHANNEL', '公共会话状态接口不可用 / Public session state unavailable')),
    session: () => invalidating ? null : domSession(doc()),
    observe: callback => {
      const document = doc(); let previous = domSession(document);
      return observeDom(document, () => { previous = domSession(document); callback(); }, () => {
        previous = null; invalidating = true;
        try { callback(); } finally { invalidating = false; }
      }, () => previous);
    }
  });
  const alive = () => { if (closed) denied('SIDEBAR_UNLOADED', '插件已卸载 / Plugin unloaded'); };
  const checkSession = (sessionId: string, guard?: () => void) => { alive(); guard?.(); if (!validId(sessionId) || domSession(doc()) !== sessionId) denied('SIDEBAR_SESSION', '会话已切换或不唯一，请在当前会话重试 / Session changed or ambiguous'); };
  const reveal = async (sessionId: string, guard?: () => void) => {
    const document = doc(), check = () => checkSession(sessionId, guard), clicked = new Set<HTMLElement>();
    check();
    const one = (selector: string) => {
      const nodes = [...document.querySelectorAll<HTMLElement>(selector)].filter(node => !node.closest('[hidden], [inert]'));
      if (nodes.length > 1) denied('SIDEBAR_AMBIGUOUS', '宿主页签控件不唯一 / Ambiguous host controls');
      return nodes[0];
    };
    const click = (node: HTMLElement | undefined) => { check(); if (!node || clicked.has(node)) return; if (node.getAttribute('aria-disabled') === 'true' || (node as HTMLButtonElement).disabled) denied('SIDEBAR_OPEN', '宿主页签控件不可用'); clicked.add(node); node.click(); };
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      check();
      const toggle = one('.app-work-panel-toggle');
      if (!toggle || !['true', 'false'].includes(toggle.getAttribute('aria-pressed') ?? '')) denied('SIDEBAR_CONTRACT', '宿主工作面板标记已变化 / Work panel markup changed');
      if (toggle.getAttribute('aria-pressed') === 'false') click(toggle);
      else {
        const tab = one(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`);
        if (tab?.getAttribute('aria-selected') === 'true') return;
        if (tab) click(tab);
        else {
          const launcher = one('[data-work-panel-launcher-item="local.diff-view/review"]');
          if (launcher) click(launcher); else click(one('.work-panel-new-tab'));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    denied('SIDEBAR_OPEN', '未找到或未能激活 Diff view 页签，请检查插件是否启用 / Review tab did not open');
  };
  return {
    async reveal(sessionId, guard) {
      const check = () => checkSession(sessionId, guard);
      check();
      await Promise.all([options.navigation?.begin?.(sessionId, check), reveal(sessionId, guard)]); check();
    },
    async subscribeSession(listener) {
      alive(); const document = doc(); let previous: string | null | undefined, stopped = false;
      const publish = () => { if (closed || stopped) return; const id = domSession(document); if (id !== previous) { previous = id; listener(id); } };
      const observer = observeDom(document, publish, () => {
        if (previous && !closed && !stopped) { previous = null; listener(null); }
      }, () => previous);
      const dispose = () => { if (stopped) return; stopped = true; observer.disconnect(); subscriptions.delete(dispose); };
      subscriptions.add(dispose); publish(); return dispose;
    },
    subscribeEvidence: listener => source.subscribeEvidence(listener),
    subscribeActivity: (listener, diagnose) => source.subscribeActivity(listener, diagnose),
    async open(sessionId, location, guard) {
      alive();
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied('SIDEBAR_TARGET', '无效的插件定位令牌 / Invalid selection token');
      if (opening) denied('SIDEBAR_BUSY', '正在打开审查页签，请勿重复点击');
      const check = () => checkSession(sessionId, guard);
      check(); opening = true;
      try {
        const navigation = options.navigation ?? denied('SIDEBAR_CHANNEL', '审查导航桥接不可用 / Review navigation unavailable');
        const [ticket] = await Promise.all([navigation.prepare(sessionId, location, check), reveal(sessionId, guard)]); check();
        await navigation.confirm(ticket, check); check();
      } finally { opening = false; }
    },
    close() { closed = true; for (const dispose of [...subscriptions]) dispose(); source.close(); }
  };
}
