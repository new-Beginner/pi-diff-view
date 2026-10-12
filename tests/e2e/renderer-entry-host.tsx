// Exact supported import-map names from the inspected PI-Desktop 0.17.0 build.
// Loads the production ESM renderer artifact, not a bundled-source replacement.
import React from 'react';
import * as ReactNamespace from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
const state = { loaded: false, error: '', styles: 0, slots: [] as string[], listeners: 0, calls: [] as string[], reports: [] as string[], shutdown: () => {} };
(window as any).__entryHost = state;
const libraries: Record<string, Record<string, any>> = { react: ReactNamespace, reactDom: ReactDom, reactDomClient: ReactDomClient };
(globalThis as any).__PI_RENDERER_HOST__ = libraries;
const imports: Record<string, string> = {};
for (const [name, library] of Object.entries({ react: 'react', 'react-dom': 'reactDom', 'react-dom/client': 'reactDomClient' })) {
  const exports = libraries[library];
  const lines = [`const host = globalThis.__PI_RENDERER_HOST__[${JSON.stringify(library)}];`];
  if ('default' in exports) lines.push('export default host.default;');
  for (const key of Object.keys(exports)) if (key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key)) lines.push(`export const ${key} = host[${JSON.stringify(key)}];`);
  imports[name] = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/javascript' }));
}
const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({ imports }); document.head.append(map);
const params = new URLSearchParams(location.search), enabled = params.get('enabled') !== 'false', failBoot = params.get('boot') === 'fail';
const boot = { repositories: [], runs: [], locale: 'zh-CN', base: 'light', settings: { layout: 'unified', wordWrap: false, nativePreflight: enabled } };
const jobs = new Map<string, any>();
const roots: ReactDomClient.Root[] = [], disposers: (() => void)[] = [];
const host = {
  async dispatch(action: string, payload: any) {
    if (action !== 'plugin.call') throw new Error('Only plugin calls in this startup test');
    state.calls.push(payload.method);
    if (payload.method === 'rendererReport') { state.reports.push(payload.args.stage); return { ok: true }; }
    if (payload.method === 'activeReviewSession') return { ok: true };
    if (payload.method === 'jobStart') { const id = `job-${jobs.size}`; jobs.set(id, failBoot ? { state: 'error', error: { code: 'TEST_BOOT_ERROR', message: 'Injected boot failure' } } : { state: 'done', result: payload.args.method === 'replyCards' ? { cards: [], revision: 'empty', pending: [], nextOffset: null, locale: boot.locale, base: boot.base } : boot }); return { jobId: id }; }
    if (payload.method === 'jobPoll') return jobs.get(payload.args.jobId);
    if (payload.method === 'nativeProbeInfo') return { version: '0.18.0', hashes: {}, supported: false, reason: 'Test host is intentionally not native' };
    throw new Error(`Unexpected method: ${payload.method}`);
  },
  ui: {
    injectStyle(css: string) { const style = document.createElement('style'); style.textContent = css; document.head.append(style); state.styles++; const dispose = () => { style.remove(); state.styles--; }; disposers.push(dispose); return dispose; },
    openLayer() { throw new Error('No review surface should open automatically during startup'); }
  },
  slots: { register(options: any) {
    if (!['entryExtra', 'composerControl'].includes(options.slot)) throw new Error('Unexpected slot');
    state.slots.push(options.slot);
    const container = document.createElement('div'); container.setAttribute('data-pi-plugin', 'local.diff-view'); container.dataset.testSlot = options.slot;
    document.body.append(container); const root = ReactDomClient.createRoot(container); roots.push(root);
    root.render(React.createElement(options.component, { sessionId: 's', messageId: 'reply', message: { content: 'No recorded capture', createdAt: new Date().toISOString() } }));
    return () => { root.unmount(); container.remove(); state.slots = state.slots.filter(slot => slot !== options.slot); };
  } },
  composer: { subscribeDraft(listener: (data: any) => void) { state.listeners++; listener({ text: 'Existing draft', marks: [], generation: 1 }); return () => { state.listeners--; }; } }
};
// esbuild deliberately retains this variable dynamic import, which the browser resolves with the map above.
const entryUrl = new URL('/production-renderer.mjs', location.href).href;
import(/* @vite-ignore */ entryUrl).then(async module => { await module.onLoad(host); state.loaded = true; state.shutdown = () => module.onUnload(); }).catch(error => { state.error = String(error.message); });
