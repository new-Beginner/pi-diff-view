import React from 'react';
import { createRoot } from 'react-dom/client';
import { onLoad, onUnload, type RendererHost } from '../../src/renderer/index';
import { createPluginReviewAdapter, resolvePluginReviewModules } from '../../src/renderer/plugin-review-adapter';
const sessionListeners = new Set<() => void>();
let renderReplies: ((visible: boolean) => void) | undefined;
const state = { draft: 'Existing draft. ', sessionId: 'session-demo', styles: 0, sidebars: 0, subscriptions: 0, positions: [] as unknown[], opens: [] as any[], hideReplies() { renderReplies?.(false); }, showReplies() { renderReplies?.(true); }, unload() { onUnload(); closeSidebar(); }, switchSession(sessionId: string) { state.sessionId = sessionId; nativeState.activeSessionId = sessionId; closeSidebar(); sessionListeners.forEach(listener => listener()); draftListener?.({ text: state.draft, marks: [], generation: 1 }); } };
let draftListener: ((value: { text: string; marks: unknown[]; generation: number } | null) => void) | null = null;
let sidebar: HTMLElement | null = null;
function closeSidebar() { sidebar?.remove(); sidebar = null; state.sidebars = 0; nativeState.workPanelOpen = false; nativeState.activeWorkPanelTabId = null; nativeState.workPanelTabs = []; document.body.classList.remove('sidebar-open'); }
const nativeState = { activeSessionId: new URLSearchParams(location.search).has('newSession') ? undefined : 'session-demo' as string | undefined, selectingSessionId: null as string | null, workPanelOpen: false, activeWorkPanelTabId: null as string | null, workPanelTabs: [] as { id: string; kind: string; resource: string; location?: string }[], pluginViews: [{ pluginId: 'local.diff-view', viewId: 'review' }], openWorkPanelTabForSession(sessionId: string, tab: any) {
  state.opens.push({ sessionId, tab }); nativeState.workPanelOpen = true; nativeState.activeWorkPanelTabId = tab.id; nativeState.workPanelTabs = [tab];
  document.body.classList.add('sidebar-open');
  if (!sidebar) {
    sidebar = document.createElement('aside'); sidebar.id = 'demo-plugin-sidebar'; sidebar.innerHTML = '<header>Diff view · 插件差异审查 <button aria-label="Close plugin sidebar">×</button></header><iframe title="Diff view plugin"></iframe>';
    document.body.append(sidebar); state.sidebars = 1; sidebar.querySelector('button')!.addEventListener('click', closeSidebar);
  }
  const frame = sidebar.querySelector('iframe')!;
  frame.src = `/sidebar-demo?piViewOpen=${encodeURIComponent(tab.location)}&lang=${new URLSearchParams(location.search).get('lang') || 'en'}&scenario=renderer`;
} };
const host: RendererHost = {
  dispatch<T>(action: string, payload?: any): Promise<T> {
    if (action !== 'plugin.call') return Promise.reject(new Error(`Unexpected renderer action: ${action}`));
    const methods = ['rendererReport', 'jobStart', 'jobPoll', 'bootstrap', 'review', 'file', 'action', 'batchAction', 'comments', 'saveComment', 'deleteComment', 'feedback', 'copyPatch', 'settings', 'clearHistory', 'card', 'replyCards', 'turnSummary', 'selectTurn', 'readTurnSelection', 'activeReviewSession'];
    if (!methods.includes(payload.method)) return Promise.reject(new Error('Method not declared in renderer whitelist'));
    return window.pluginBridge!.invoke<T>(`diff.${payload.method}`, payload.args);
  },
  ui: { injectStyle(css) { const element = document.createElement('style'); element.textContent = css; document.head.append(element); state.styles++; return () => { element.remove(); state.styles--; }; } },
  slots: { register(options) {
    state.positions.push({ slot: options.slot });
    const params = new URLSearchParams(location.search), target = params.has('latestAtEnd') ? 11 : 0;
    const element = document.createElement('div'); element.dataset.testSlot = options.slot; (document.getElementById('mock-reply') ?? document.body).append(element);
    const root = createRoot(element); const Component = options.component;
    const historyCount = Number(params.get('historyCards') || 0);
    renderReplies = visible => root.render(visible ? <>{Array.from({ length: historyCount || 12 }, (_, index) => <Component key={index} sessionId="session-demo" messageId={historyCount ? `history-${index}` : index === target ? 'reply-demo' : `unbound-${index}`} message={{ content: index === target && params.has('longReply') ? `${'进度😀\n\n'.repeat(12000)}Demo reply ${index}` : `Demo reply ${index}`, createdAt: new Date(Date.parse('2025-06-15T15:07:40.000Z') + (params.has('latestAtEnd') ? index * 1000 : 0)).toISOString() }} />)}</> : null);
    renderReplies(true);
    return () => { root.unmount(); element.remove(); };
  } },
  composer: { subscribeDraft(listener) { draftListener = listener; state.subscriptions++; listener({ text: state.draft, marks: [], generation: 1 }); return () => { draftListener = null; state.subscriptions--; }; } }
};
const adapter = createPluginReviewAdapter({ load: async () => resolvePluginReviewModules({ R: { getState: () => nativeState, subscribe(listener: (value: typeof nativeState) => void) { const notify = () => listener(nativeState); sessionListeners.add(notify); state.subscriptions++; return () => { sessionListeners.delete(notify); state.subscriptions--; }; } }, r: React, aO: () => { throw new Error('Old minified tab export must not be called'); } }) });
(window as any).__rendererDemo = state;
onLoad(host, { adapter });
