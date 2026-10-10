import React from 'react';
import { createRoot } from 'react-dom/client';
import { onLoad, onUnload, type RendererHost } from '../../src/renderer/index';
const roots: ReturnType<typeof createRoot>[] = [];
const state = { draft: 'Existing draft. ', sessionId: 'session-demo', inserts: [] as { text: string; sessionId: string; gesture: boolean }[], styles: 0, layers: 0, subscriptions: 0, positions: [] as unknown[], unload() { onUnload(); }, switchSession(sessionId: string) { state.sessionId = sessionId; draftListener?.({ sessionId, text: state.draft }); } };
let draftListener: ((value: { sessionId: string; text: string }) => void) | null = null;
const host: RendererHost = {
  dispatch<T>(action: string, payload?: any): Promise<T> {
    if (action === 'plugin.call') {
      const methods = ['jobStart', 'jobPoll', 'bootstrap', 'review', 'file', 'action', 'batchAction', 'comments', 'saveComment', 'deleteComment', 'feedback', 'copyPatch', 'settings', 'clearHistory', 'card', 'openPanel'];
      if (!methods.includes(payload.method)) return Promise.reject(new Error('Method not declared in renderer whitelist'));
      return window.pluginBridge!.invoke<T>(`diff.${payload.method}`, payload.args);
    }
    if (action === 'composer.insertText') {
      const gesture = navigator.userActivation.isActive;
      if (!gesture || typeof payload.text !== 'string' || Object.keys(payload).some(k => k !== 'text')) return Promise.reject(new Error('Gesture/payload guard rejected insertion'));
      state.inserts.push({ ...payload, sessionId: state.sessionId, gesture }); state.draft += payload.text; return Promise.resolve(undefined as T);
    }
    return Promise.reject(new Error(`Unexpected renderer action: ${action}`));
  },
  ui: {
    injectStyle(css) { const element = document.createElement('style'); element.textContent = css; document.head.append(element); state.styles++; return () => { element.remove(); state.styles--; }; },
    openLayer() { const element = document.createElement('div'); document.body.append(element); state.layers++; return { element, close: () => { element.remove(); state.layers--; } }; }
  },
  slots: { register(options) {
    state.positions.push({ slot: options.slot, positions: options.positions });
    const element = document.createElement('div'); element.dataset.testSlot = options.slot; document.body.append(element);
    const root = createRoot(element); roots.push(root); const Component = options.component;
    if (options.slot === 'composerControl') root.render(<Component />);
    else root.render(<>{Array.from({ length: 12 }, (_, index) => <Component key={index} sessionId="session-demo" messageId={index === 0 ? 'reply-demo' : `unbound-${index}`} message={{ content: `Demo reply ${index}`, createdAt: '2025-06-15T15:07:40.000Z' }} />)}</>);
    return () => { root.unmount(); element.remove(); };
  } },
  composer: { subscribeDraft(listener) { draftListener = listener; state.subscriptions++; listener({ sessionId: state.sessionId, text: state.draft }); return () => { draftListener = null; state.subscriptions--; }; } }
};
(window as any).__rendererDemo = state;
onLoad(host);
