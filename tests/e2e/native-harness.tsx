// Explicitly mocked native contracts. This is NOT PI-Desktop or its actual review component.
import React, { useState } from 'react';
import { createNativeReviewAdapter, type NativeModules, type NativePresentation } from '../../src/renderer/native-review-adapter';
import { NATIVE_BUILD } from '../../src/core/native-build-contract';
const record = Object.freeze({ id: 'workspace-tool', role: 'tool', toolName: 'Write', toolStatus: 'success', toolResult: { details: { root: 'workspace', review: { snapshotId: 'workspace-snapshot', messageId: 'workspace-tool', path: 'docs/native-preflight-fixture.txt' } } } });
const messages: unknown[] = [record];
const initial = JSON.stringify(messages), listeners = new Set<() => void>();
let renderFailure = false;
const state = { activeSessionId: 's' as string | null, selectingSessionId: null, isRunning: false, messages, workPanelOpen: false, activeWorkPanelTabId: null as string | null, opens: 0, loads: 0, infoVersion: '0.17.0', reversibleComponent: false, missingComponent: false,
  openWorkPanelTabForSession(sessionId: string, tab: { id: string; kind: string }) {
    if (sessionId !== this.activeSessionId || tab.id !== 'review') throw new Error('Session guard failed');
    this.opens++; this.workPanelOpen = true; this.activeWorkPanelTabId = tab.id;
    if (!document.getElementById('work-panel-surface-review')) {
      const pane = document.createElement('div'); pane.id = 'work-panel-surface-review'; pane.className = 'work-panel-tabpane'; pane.setAttribute('role', 'tabpanel');
      pane.innerHTML = '<div class="review-tab"><p>Mock native review — not actual PI-Desktop</p><div class="review-scroll"><section class="review-change-card"><button class="review-change-card-header" aria-expanded="false"><span class="review-change-card-path" title="docs/native-preflight-fixture.txt">docs/native-preflight-fixture.txt</span></button></section></div></div>';
      pane.querySelector('button')!.addEventListener('click', event => { const button = event.currentTarget as HTMLElement; button.setAttribute('aria-expanded','true'); if (!button.parentElement!.querySelector('.review-change-card-body')) { const body = document.createElement('div'); body.className = 'review-change-card-body'; body.textContent = 'Actual fixture record mock'; button.parentElement!.append(body); } });
      document.body.append(pane);
    }
    for (const listener of listeners) listener();
  }
};
const parse = (value: any) => value?.toolResult?.details?.root === 'workspace' ? value.toolResult.details.review : null;
function Component({ message }: { message: any }) {
  const [open, setOpen] = useState(false);
  if (renderFailure) throw new Error('Injected native component failure');
  if (state.missingComponent) return <div>Missing pinned component</div>;
  const review = parse(message);
  return <section className="review-change-card"><button className="review-change-card-header" aria-expanded={open} onClick={() => setOpen(!open)}><span className="review-change-card-path" title={review.path}>{review.path}</span></button>{open && <div className="review-change-card-body"><div className="review-change-diff">{review.hunks.map((h: any) => <pre key={h.header}>{h.lines.map((l: any) => l.text).join('\n')}</pre>)}</div>{state.reversibleComponent && <button className="review-change-rollback">Rollback should never be exposed</button>}</div>}</section>;
}
const modules: NativeModules = { hostReact: React, component: Component, parse, records: values => values.flatMap(message => { const change = parse(message); return change ? [{ message, change }] : []; }), tab: kind => ({ id: kind, kind }), store: { getState: () => state, subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } } };
const info = () => Promise.resolve({ version: state.infoVersion, supported: true, hashes: Object.fromEntries(Object.values(NATIVE_BUILD.assets).map(a => [a.name, a.sha256])) });
let adapter = createNativeReviewAdapter({ info, load: async () => { state.loads++; return modules; } });
const presentation: NativePresentation = { id: 'sample', path: 'D:/outside/demo.txt', origin: 'external', demo: true, additions: 1, deletions: 1, hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ type: 'del', text: 'before demo' }, { type: 'add', text: 'after demo' }] }] };
(window as any).__nativeProbe = {
  state,
  async probe(sessionId = 's') { return adapter.probe(sessionId, 'docs/native-preflight-fixture.txt', presentation); },
  failRender() { renderFailure = true; },
  subscriptions: () => listeners.size, unchanged: () => initial === JSON.stringify(state.messages),
  close() { adapter.close(); },
  reset() { adapter.close(); adapter = createNativeReviewAdapter({ info, load: async () => { state.loads++; return modules; } }); },
  switchSession() { state.activeSessionId = 'other'; for (const fn of listeners) fn(); },
  closeTab() { state.workPanelOpen = false; state.activeWorkPanelTabId = null; document.getElementById('work-panel-surface-review')?.remove(); for (const fn of listeners) fn(); }
};
