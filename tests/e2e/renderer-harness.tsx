import React from 'react';
import { createRoot } from 'react-dom/client';
import { onLoad, onUnload, type RendererHost } from '../../src/renderer/index';
import { createPluginReviewAdapter } from '../../src/renderer/plugin-review-adapter';
import { NATIVE_BUILD } from '../../src/core/native-build-contract';
const state = { draft: 'Existing draft. ', sessionId: 'session-demo', styles: 0, sidebars: 0, subscriptions: 0, positions: [] as unknown[], opens: [] as any[], unload() { onUnload(); closeSidebar(); }, switchSession(sessionId: string) { state.sessionId = sessionId; nativeState.activeSessionId = sessionId; closeSidebar(); draftListener?.({ sessionId, text: state.draft }); } };
let draftListener: ((value: { sessionId: string; text: string }) => void) | null = null;
let sidebar: HTMLElement | null = null;
function closeSidebar() { sidebar?.remove(); sidebar = null; state.sidebars = 0; document.body.classList.remove('sidebar-open'); }
const nativeState = { activeSessionId: 'session-demo', workPanelOpen: false, activeWorkPanelTabId: null as string | null, pluginViews: [{ pluginId: 'local.diff-view', viewId: 'review' }], openWorkPanelTabForSession(sessionId: string, tab: any) {
  state.opens.push({ sessionId, tab }); nativeState.workPanelOpen = true; nativeState.activeWorkPanelTabId = tab.id;
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
    const methods = ['rendererReport', 'jobStart', 'jobPoll', 'bootstrap', 'review', 'file', 'action', 'batchAction', 'comments', 'saveComment', 'deleteComment', 'feedback', 'copyPatch', 'settings', 'clearHistory', 'card', 'turnSummary', 'selectTurn', 'readTurnSelection', 'activeReviewSession'];
    if (!methods.includes(payload.method)) return Promise.reject(new Error('Method not declared in renderer whitelist'));
    return window.pluginBridge!.invoke<T>(`diff.${payload.method}`, payload.args);
  },
  ui: { injectStyle(css) { const element = document.createElement('style'); element.textContent = css; document.head.append(element); state.styles++; return () => { element.remove(); state.styles--; }; } },
  slots: { register(options) {
    state.positions.push({ slot: options.slot });
    const element = document.createElement('div'); element.dataset.testSlot = options.slot; (document.getElementById('mock-reply') ?? document.body).append(element);
    const root = createRoot(element); const Component = options.component;
    root.render(<>{Array.from({ length: 12 }, (_, index) => <Component key={index} sessionId="session-demo" messageId={index === 0 ? 'reply-demo' : `unbound-${index}`} message={{ content: `Demo reply ${index}`, createdAt: '2025-06-15T15:07:40.000Z' }} />)}</>);
    return () => { root.unmount(); element.remove(); };
  } },
  composer: { subscribeDraft(listener) { draftListener = listener; state.subscriptions++; listener({ sessionId: state.sessionId, text: state.draft }); return () => { draftListener = null; state.subscriptions--; }; } }
};
const adapter = createPluginReviewAdapter({ info: async () => ({ version: NATIVE_BUILD.version, supported: true, hashes: Object.fromEntries(Object.values(NATIVE_BUILD.assets).map(asset => [asset.name, asset.sha256])) }), load: async () => ({ store: { getState: () => nativeState }, tab: (pluginId, viewId) => ({ id: `plugin:${pluginId}/${viewId}`, kind: 'plugin', resource: `${pluginId}/${viewId}` }), hostReact: React }) });
(window as any).__rendererDemo = state;
onLoad(host, { adapter });
