import React from 'react';
import { createRoot } from 'react-dom/client';
import { onLoad, onUnload, type RendererHost } from '../../src/renderer/index';
import { createPluginReviewAdapter, resolvePluginReviewModules } from '../../src/renderer/plugin-review-adapter';
import { createReviewSurfaceClient } from '../../src/renderer/review-surface-client';
const sessionListeners = new Set<() => void>();
let renderReplies: ((visible: boolean, sessionId?: string) => void) | undefined;
const state = { draft: 'Existing draft. ', sessionId: 'session-demo', styles: 0, sidebars: 0, subscriptions: 0, positions: [] as unknown[], opens: [] as any[], hideReplies() { renderReplies?.(false); }, showReplies(sessionId?: string) { renderReplies?.(true, sessionId); }, unload() { surface.dispose(); onUnload(); closeSidebar(); }, switchSession(sessionId: string) { state.sessionId = sessionId; nativeState.activeSessionId = sessionId; pane.dataset.sessionPane = sessionId; surface.update(sessionId); closeSidebar(); sessionListeners.forEach(listener => listener()); draftListener?.({ text: state.draft, marks: [], generation: 1 }); } };
let draftListener: ((value: { text: string; marks: unknown[]; generation: number } | null) => void) | null = null;
let sidebar: HTMLElement | null = null;
function closeSidebar() { sidebar?.remove(); sidebar = null; state.sidebars = 0; toggle.setAttribute('aria-pressed', 'false'); tab.remove(); document.body.classList.remove('sidebar-open'); }
const nativeState = { activeSessionId: new URLSearchParams(location.search).has('newSession') ? undefined : 'session-demo' as string | undefined, selectingSessionId: null as string | null };
const pane = document.createElement('div'); if (nativeState.activeSessionId) pane.dataset.sessionPane = nativeState.activeSessionId; pane.dataset.visible = 'true'; document.body.append(pane);
const toggle = document.createElement('button'); toggle.className = 'app-work-panel-toggle'; toggle.setAttribute('aria-pressed', 'false'); document.body.append(toggle);
const tab = document.createElement('div'); tab.dataset.workPanelTabId = 'plugin:local.diff-view/review'; tab.innerHTML = '<button role="tab" aria-selected="true">Diff view</button>';
toggle.onclick = () => { toggle.setAttribute('aria-pressed', 'true'); document.body.append(tab); openSidebar(); };
function openSidebar() {
  if (sidebar) return;
  state.opens.push({ sessionId: state.sessionId, tab: { id: 'plugin:local.diff-view/review', resource: 'local.diff-view/review' } });
  document.body.classList.add('sidebar-open'); sidebar = document.createElement('aside'); sidebar.id = 'demo-plugin-sidebar';
  sidebar.innerHTML = '<header>Diff view · 插件差异审查 <button aria-label="Close plugin sidebar">×</button></header><iframe title="Diff view plugin"></iframe>';
  document.body.append(sidebar); state.sidebars = 1; sidebar.querySelector('button')!.addEventListener('click', closeSidebar);
  sidebar.querySelector('iframe')!.src = `/sidebar-demo?lang=${new URLSearchParams(location.search).get('lang') || 'en'}&scenario=renderer`;
}
const host: RendererHost = {
  dispatch<T>(action: string, payload?: any): Promise<T> {
    if (action !== 'plugin.call') return Promise.reject(new Error(`Unexpected renderer action: ${action}`));
    if (payload.method === 'sessionEvidence' || payload.method === 'sessionContext') return Promise.resolve({ ok: true } as T);
    const methods = ['reviewSurface', 'rendererReport', 'jobStart', 'jobPoll', 'bootstrap', 'review', 'file', 'action', 'batchAction', 'comments', 'saveComment', 'deleteComment', 'feedback', 'copyPatch', 'settings', 'clearHistory', 'card', 'replyCards', 'turnSummary', 'runningChanges', 'selectTurn', 'readTurnSelection', 'activeReviewSession'];
    if (!methods.includes(payload.method)) return Promise.reject(new Error('Method not declared in renderer whitelist'));
    return window.pluginBridge!.invoke<T>(`diff.${payload.method}`, payload.args);
  },
  ui: { injectStyle(css) { const element = document.createElement('style'); element.textContent = new URLSearchParams(location.search).get('scopedStyles') === 'true' ? `@scope ([data-pi-plugin="local.diff-view"]) { ${css} }` : css; document.head.append(element); state.styles++; return () => { element.remove(); state.styles--; }; } },
  slots: { register(options) {
    state.positions.push({ slot: options.slot });
    if (options.slot === 'composerControl') {
      const element = document.createElement('div'); element.dataset.testSlot = options.slot; element.dataset.piPlugin = 'local.diff-view'; (document.querySelector('.mock-composer') ?? document.body).append(element);
      const root = createRoot(element); root.render(React.createElement(options.component));
      return () => { root.unmount(); element.remove(); };
    }
    const params = new URLSearchParams(location.search), target = params.has('latestAtEnd') ? 11 : 0;
    const element = document.createElement('div'); element.dataset.testSlot = options.slot; element.dataset.piPlugin = 'local.diff-view'; (document.getElementById('mock-reply') ?? document.body).append(element);
    const root = createRoot(element); const Component = options.component;
    const historyCount = Number(params.get('historyCards') || 0);
    renderReplies = (visible, sessionId = 'session-demo') => root.render(visible ? <>{Array.from({ length: historyCount || 12 }, (_, index) => <Component key={index} sessionId={sessionId} messageId={historyCount ? `history-${index}` : index === target ? 'reply-demo' : `unbound-${index}`} message={{ ...(params.has('childReply') && index === target ? { parentToolCallId: 'launch-parent' } : {}), content: index === target && params.has('longReply') ? `${'进度😀\n\n'.repeat(12000)}Demo reply ${index}` : `Demo reply ${index}`, createdAt: new Date(Date.parse('2025-06-15T15:07:40.000Z') + (params.has('latestAtEnd') ? index * 1000 : 0)).toISOString() }} />)}</> : null);
    renderReplies(true);
    return () => { root.unmount(); element.remove(); };
  } },
  composer: { subscribeDraft(listener) { draftListener = listener; state.subscriptions++; listener({ text: state.draft, marks: [], generation: 1 }); return () => { draftListener = null; state.subscriptions--; }; } }
};
const surface = createReviewSurfaceClient({ invoke: (method, args) => host.dispatch('plugin.call', { method, args }) });
surface.update(nativeState.activeSessionId ?? null);
const adapter = createPluginReviewAdapter({ navigation: surface.channel, load: async () => resolvePluginReviewModules({ R: { getState: () => nativeState, subscribe(listener: (value: typeof nativeState) => void) { const notify = () => listener(nativeState); sessionListeners.add(notify); state.subscriptions++; return () => { sessionListeners.delete(notify); state.subscriptions--; }; } }, r: React }) });
(window as any).__rendererDemo = state;
(state as any).followSession = (sessionId: string) => { state.sessionId = sessionId; nativeState.activeSessionId = sessionId; pane.dataset.sessionPane = sessionId; surface.update(sessionId); sessionListeners.forEach(listener => listener()); };
(state as any).openSelection = (nonce: string) => adapter.open(nativeState.activeSessionId!, `diff-view:${nonce}`);
onLoad(host, { adapter });
