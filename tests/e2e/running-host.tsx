// Final ESM renderer + mock host UI; RPC is supplied by the real SnapshotStore/ReviewService in the test.
import React from 'react';
import * as ReactNamespace from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import { createPluginReviewAdapter } from '../../src/renderer/plugin-review-adapter';
import { createReviewSurfaceClient } from '../../src/renderer/review-surface-client';
const config = (window as any).__liveFixture;
const libraries = { react: ReactNamespace, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient };
const imports: Record<string, string> = {};
for (const [name, library] of Object.entries(libraries)) {
  const key = `__live_${name}`; (globalThis as any)[key] = library;
  const lines = [`const host = globalThis[${JSON.stringify(key)}];`];
  for (const name of Object.keys(library)) if (name === 'default') lines.push('export default host.default;'); else if (/^[A-Za-z_$][\w$]*$/.test(name)) lines.push(`export const ${name} = host[${JSON.stringify(name)}];`);
  imports[name] = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/javascript' }));
}
const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({ imports }); document.head.append(map);
const subscribers = new Set<(state: typeof nativeState) => void>();
const nativeState = { page: 'chat', activeSessionId: 's', selectingSessionId: null as string | null, runningSessions: { s: true } as Record<string, boolean>, messages: [{ id: 'current-user', role: 'user', createdAt: config.since }], agentStatuses: { s: { currentTurnId: 'host-turn' } }, workPanelOpen: false, activeWorkPanelTabId: null as string | null, pluginViews: [{ pluginId: 'local.diff-view', viewId: 'review' }], openWorkPanelTabForSession(sessionId: string, tab: any) {
  state.opens.push({ sessionId, tab }); nativeState.workPanelOpen = true; nativeState.activeWorkPanelTabId = tab.id;
  const sidebar = document.getElementById('live-sidebar')!; sidebar.hidden = false;
  sidebar.querySelector('iframe')!.src = `/live-sidebar?piViewOpen=${encodeURIComponent(tab.location)}`;
} };
(nativeState as any).sessions = [{ id: 's', projectPath: '/live-test-project' }];
let entry: any;
let composerComponent: React.ComponentType<any>;
const duplicates: { root: ReactDomClient.Root; container: HTMLElement }[] = [];
const state = { loaded: false, error: '', styles: 0, layers: 0, layerOpens: 0, slots: [] as any[], calls: [] as any[], opens: [] as any[],
  notify() { subscribers.forEach(listener => listener(nativeState)); },
  updateEvidence(messages: any[]) { (nativeState as any).messages = messages; state.notify(); },
  setRunning(running: boolean) { nativeState.runningSessions[nativeState.activeSessionId] = running; state.notify(); },
  switchSession(sessionId: string) { nativeState.activeSessionId = sessionId; document.querySelector('[data-session-pane]')!.setAttribute('data-session-pane', sessionId); surface?.update(sessionId); state.notify(); },
  task(id: string, since: number) { nativeState.messages = [{ id, role: 'user', createdAt: since }]; nativeState.runningSessions[nativeState.activeSessionId] = true; state.notify(); },
  duplicateComposer() { const container = document.createElement('span'); container.dataset.piPlugin = 'local.diff-view'; document.querySelector('.composer-left')!.append(container); const root = ReactDomClient.createRoot(container); root.render(React.createElement(composerComponent)); duplicates.push({ root, container }); },
  windowTranscript() { (nativeState as any).retainedTranscripts = { s: nativeState.messages }; nativeState.messages = []; state.notify(); },
  unload() { surface?.dispose(); entry.onUnload(); }, reload() { surface?.dispose(); entry.onLoad(host, { adapter: adapter() }); },
  suspendLayers(suspended: boolean) { const root = document.getElementById('live-plugin-layers'); if (root) { root.hidden = suspended; root.inert = suspended; } },
  get subscriptions() { return subscribers.size; }
};
(window as any).__liveHost = state;
const host = {
  async dispatch(action: string, payload: any) {
    if (action !== 'plugin.call') throw new Error(`Draft or messaging action is forbidden: ${action}`);
    state.calls.push(payload);
    const response = await fetch('/live-rpc', { method: 'POST', body: JSON.stringify(payload) }); const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message), { code: data.code }); return data;
  },
  ui: {
    injectStyle(css: string) { const style = document.createElement('style'); style.textContent = config.scopedStyles ? `@scope ([data-pi-plugin="local.diff-view"]) { ${css} }` : css; document.head.append(style); state.styles++; return () => { style.remove(); state.styles--; }; },
    ...(config.layerApi === 'missing' ? {} : { openLayer() {
      if (config.layerApi === 'reject') throw new Error('Host refused layer');
      let root = document.getElementById('live-plugin-layers');
      if (!root) { root = document.createElement('div'); root.id = 'live-plugin-layers'; document.body.append(root); }
      const element = document.createElement('div'); element.dataset.piPlugin = 'local.diff-view'; element.dataset.piLayer = '';
      Object.assign(element.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '600' });
      root.append(element); state.layers++; state.layerOpens++;
      let closed = false;
      return { element, close() { if (closed) return; closed = true; element.remove(); if (--state.layers === 0) root!.remove(); } };
    } })
  },
  slots: { register(options: any) {
    if (options.slot === 'composerControl') composerComponent = options.component;
    state.slots.push({ slot: options.slot, positions: options.positions }); const container = document.createElement('span'); container.dataset.testSlot = options.slot;
    container.dataset.piPlugin = 'local.diff-view';
    document.querySelector(options.slot === 'entryExtra' ? '#live-reply' : '.composer-left')!.append(container);
    const root = ReactDomClient.createRoot(container); root.render(React.createElement(options.component, { sessionId: 's', messageId: 'final-reply', message: { content: 'Done live task', createdAt: config.replyAt } }));
    return () => { if (options.slot === 'composerControl') for (const item of duplicates.splice(0)) { item.root.unmount(); item.container.remove(); } root.unmount(); container.remove(); state.slots = state.slots.filter(slot => slot.slot !== options.slot); };
  } },
  composer: { subscribeDraft() { throw new Error('No draft reads required'); } }
};
let surface: ReturnType<typeof createReviewSurfaceClient> | undefined;
function adapter() {
  surface = createReviewSurfaceClient({ invoke: (method, args) => host.dispatch('plugin.call', { method, args }) }); surface.update(nativeState.activeSessionId);
  return createPluginReviewAdapter({ navigation: surface.channel, load: async () => ({ store: { getState: () => nativeState, subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; } }, hostReact: React }) });
}
const pane = document.createElement('div'); pane.dataset.sessionPane = nativeState.activeSessionId; pane.dataset.visible = 'true'; document.body.append(pane);
const toggle = document.createElement('button'); toggle.className = 'app-work-panel-toggle'; toggle.setAttribute('aria-pressed', 'false'); toggle.onclick = () => toggle.setAttribute('aria-pressed', 'true'); document.body.append(toggle);
const tab = document.createElement('div'); tab.dataset.workPanelTabId = 'plugin:local.diff-view/review'; tab.innerHTML = '<button role="tab" aria-selected="false">Diff view</button>'; document.body.append(tab);
tab.querySelector('button')!.onclick = () => {
  tab.querySelector('button')!.setAttribute('aria-selected', 'true');
  state.opens.push({ sessionId: nativeState.activeSessionId, tab: { id: 'plugin:local.diff-view/review' } });
  document.getElementById('live-sidebar')!.hidden = false; document.querySelector<HTMLIFrameElement>('#live-sidebar iframe')!.src = '/live-sidebar?surface=1';
};
const entryUrl = new URL('/live-production.mjs', location.href).href;
import(/* @vite-ignore */ entryUrl).then(module => { entry = module; state.reload(); state.loaded = true; }).catch(error => state.error = String(error));
