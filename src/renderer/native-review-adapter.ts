import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NATIVE_BUILD, matchesNativeBuild, type NativeBuildInfo } from '../core/native-build-contract';
export interface NativeReference { messageId: string; snapshotId: string; path: string; }
export interface NativePresentation {
  id: string; path: string; origin: 'external' | 'workspace'; additions: number; deletions: number;
  hunks: { header: string; lines: { type: 'add' | 'del' | 'context'; text: string }[] }[];
  demo?: boolean;
}
interface NativeChange { snapshotId: string; messageId: string; path: string; }
interface NativeState {
  activeSessionId: string | null; selectingSessionId?: string | null; isRunning?: boolean;
  messages: unknown[]; workPanelOpen: boolean; activeWorkPanelTabId: string | null;
  openWorkPanelTabForSession(sessionId: string, tab: { id: string; kind: string }): void;
}
export interface NativeModules {
  store: { getState(): NativeState; subscribe(callback: () => void): () => void };
  parse(message: unknown): NativeChange | null;
  records(messages: unknown[]): { message: unknown; change: NativeChange }[];
  tab(kind: 'review'): { id: string; kind: string };
  component: React.ElementType;
  hostReact: Pick<typeof React, 'createElement' | 'useState'>;
}
export interface ProbeEvidence { opened: boolean; located: boolean; externalRendered: boolean; readonly: boolean; sessionGuard: boolean; }
export class NativeReviewError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function denied(code: string, message: string): never { throw new NativeReviewError(code, message); }
/** Only the root module already used by this document; never discover arbitrary globals or import another entry. */
export function pinnedModuleUrls(documentUrl: string, scriptUrls: string[]): { main: string; transcript: string } {
  const page = new URL(documentUrl);
  if (page.protocol !== 'file:' || !/\/app\.asar\/out\/renderer\/index\.html$/.test(page.pathname)) denied('NATIVE_ORIGIN', 'Not the inspected native renderer document');
  const main = new URL(`assets/${NATIVE_BUILD.assets.main.name}`, page).href;
  if (scriptUrls.filter(url => new URL(url, page).href === main).length !== 1) denied('NATIVE_ENTRY', 'Pinned main module is not the document entry');
  return { main, transcript: new URL(`assets/${NATIVE_BUILD.assets.transcript.name}`, page).href };
}
async function loadPinnedModules(): Promise<NativeModules> {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).map(script => script.src);
  const urls = pinnedModuleUrls(document.location.href, scripts);
  const main = await import(/* @vite-ignore */ urls.main);
  const transcript = await import(/* @vite-ignore */ urls.transcript);
  return { store: main.R, parse: main.bp, records: main.au, tab: main.V, component: transcript.R, hostReact: main.r };
}
/** This isolated display DTO is NEVER appended to messages, tool results or the host database. */
export function nativeDisplayDto(presentation: NativePresentation): unknown {
  if (!presentation.id || !presentation.path || presentation.path.length > 4096 || presentation.hunks.length > 20 || presentation.hunks.reduce((n, h) => n + h.lines.length, 0) > 100 || !Number.isSafeInteger(presentation.additions) || presentation.additions < 0 || !Number.isSafeInteger(presentation.deletions) || presentation.deletions < 0) denied('NATIVE_DISPLAY_LIMIT', 'Invalid or oversized native presentation');
  const dto = { id: `diff-view-display:${presentation.id}`, role: 'tool', toolName: 'Write', toolStatus: 'success',
    // root is a rendering discriminator required by the internal component, NOT an authorization claim.
    toolResult: { details: { root: 'workspace', pluginPresentation: { owner: 'local.diff-view', origin: presentation.origin, demo: presentation.demo === true }, review: { version: 1, snapshotId: `diff-view-display:${presentation.id}`, messageId: `diff-view-display:${presentation.id}`, path: presentation.path, operation: 'write', status: 'modified', state: 'active', additions: presentation.additions, deletions: presentation.deletions, hunks: presentation.hunks, reversible: false } } } };
  if (new TextEncoder().encode(JSON.stringify(dto)).length > 30000) denied('NATIVE_DISPLAY_LIMIT', 'Native display exceeds 30 KiB');
  return dto;
}
interface Options { info(): Promise<NativeBuildInfo>; load?: () => Promise<NativeModules>; }
export function createNativeReviewAdapter(options: Options) {
class NativeDisplayBoundary extends React.Component<{ children: React.ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? React.createElement('p', { role: 'alert' }, 'Native component failed') : this.props.children; }
}
  let closed = false, modules: NativeModules | undefined, pending: Promise<NativeModules> | undefined;
  let mount: { element: HTMLElement; root: Root; stop: () => void } | undefined;
  const unmount = () => { const current = mount; mount = undefined; if (current) { current.stop(); current.root.unmount(); current.element.remove(); } };
  let probing = false;
  const alive = () => { if (closed) denied('NATIVE_UNLOADED', 'Native adapter unloaded'); };
  const inspect = async (): Promise<NativeModules> => {
    alive();
    if (modules) return modules;
    if (!pending) pending = (async () => {
      const info = await options.info(); alive();
      if (!info.supported || !matchesNativeBuild(info.version, info.hashes)) denied('NATIVE_BUILD', info.reason ?? 'Host version/build is not supported');
      const result = await (options.load ?? loadPinnedModules)(); alive();
      if (typeof result.store?.getState !== 'function' || typeof result.store?.subscribe !== 'function' || typeof result.parse !== 'function' || typeof result.records !== 'function' || typeof result.tab !== 'function' || !result.component || result.hostReact?.createElement !== React.createElement || result.hostReact?.useState !== React.useState) denied('NATIVE_CONTRACT', 'Native exports or React identity changed');
      const state = result.store.getState();
      if (typeof state.openWorkPanelTabForSession !== 'function' || !Array.isArray(state.messages) || result.tab('review').kind !== 'review' || result.tab('review').id !== 'review') denied('NATIVE_CONTRACT', 'Native work-panel contract changed');
      modules = result; return result;
    })();
    return pending;
  };
  const guard = (sessionId: string, native: NativeModules) => { alive(); const state = native.store.getState(); if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied('NATIVE_SESSION', 'Session changed; no old-session review was opened'); return state; };
  const isReview = (sessionId: string, native: NativeModules) => { const s = native.store.getState(); return !closed && s.activeSessionId === sessionId && !s.selectingSessionId && s.workPanelOpen && s.activeWorkPanelTabId === 'review'; };
  const pane = () => document.querySelector<HTMLElement>('#work-panel-surface-review.work-panel-tabpane[role="tabpanel"]');
  const wait = async (sessionId: string, native: NativeModules, predicate: () => boolean) => {
    const end = Date.now() + 2000;
    while (Date.now() < end) { guard(sessionId, native); if (!isReview(sessionId, native)) denied('NATIVE_CLOSED', 'Review tab was closed or changed'); if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    denied('NATIVE_SURFACE', 'Expected native review surface was not rendered');
  };
  const locate = (native: NativeModules, reference: NativeReference, sessionId: string) => {
    const state = guard(sessionId, native);
    const records = native.records(state.messages), index = records.findIndex(record => record.change.snapshotId === reference.snapshotId && record.change.messageId === reference.messageId && record.change.path === reference.path);
    if (index < 0 || records.filter(record => record.change.snapshotId === reference.snapshotId).length !== 1) denied('NATIVE_RECORD', 'Native snapshot is missing or ambiguous; nothing was guessed');
    const headers = pane()?.querySelectorAll<HTMLButtonElement>('.review-scroll > section.review-change-card > button.review-change-card-header');
    const header = headers?.[index];
    if (!header || header.querySelector('.review-change-card-path')?.getAttribute('title') !== reference.path) denied('NATIVE_ANCHOR', 'Native snapshot/DOM order no longer matches this build');
    if (header.getAttribute('aria-expanded') === 'false') header.click(); // Only this bounded diff disclosure, never permissions/rollback.
    header.scrollIntoView({ block: 'nearest' });
    return header;
  };
  const show = async (native: NativeModules, sessionId: string, presentation: NativePresentation) => {
    guard(sessionId, native); unmount();
    const surface = pane(); if (!surface || !isReview(sessionId, native)) denied('NATIVE_SURFACE', 'Native review tab is not visible');
    const scroll = surface.querySelector<HTMLElement>('.review-scroll'); if (!scroll) denied('NATIVE_SURFACE', 'Pinned native review list is missing');
    const message = nativeDisplayDto(presentation), parsed = native.parse(message);
    if (!parsed || parsed.snapshotId !== `diff-view-display:${presentation.id}` || parsed.path !== presentation.path) denied('NATIVE_CONTRACT', 'Native parser rejected isolated display DTO');
    const element = document.createElement('section'); element.dataset.diffViewNativeSupplement = presentation.id;
    element.style.cssText = 'padding:12px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);max-height:320px;overflow:auto;min-height:64px';
    scroll.append(element); const root = createRoot(element);
    let stopped = false;
    let renderError: Error | undefined;
    const unsubscribe = native.store.subscribe(() => { if (!isReview(sessionId, native)) unmount(); });
    const observer = new MutationObserver(() => { if (!element.isConnected || !isReview(sessionId, native)) unmount(); });
    observer.observe(surface.parentElement ?? surface, { childList: true, subtree: true });
    const stop = () => { if (!stopped) { stopped = true; unsubscribe(); observer.disconnect(); } };
    mount = { element, root, stop };
    root.render(React.createElement(React.Fragment, null,
      React.createElement('p', null, presentation.demo ? '工作区外文件演示 / External-file demo — 仅验证原生组件，不是聊天记录或真实采集 / not a transcript record or capture' : `插件记录 / Plugin capture — ${presentation.origin === 'external' ? '工作区外 / outside workspace' : 'workspace'}`),
      React.createElement(NativeDisplayBoundary, { onError: error => { renderError = error; }, children: React.createElement(native.component, { message, compact: true }) }),
      React.createElement('button', { type: 'button', onClick: unmount }, '移除演示 / Remove display')));
    try {
      await wait(sessionId, native, () => { if (renderError) denied('NATIVE_RENDER', `Native component failed: ${renderError.message.slice(0, 200)}`); return !!element.querySelector('button.review-change-card-header'); });
      const header = element.querySelector<HTMLButtonElement>('button.review-change-card-header')!;
      if (header.getAttribute('aria-expanded') === 'false') header.click();
      await wait(sessionId, native, () => { if (renderError) denied('NATIVE_RENDER', `Native component failed: ${renderError.message.slice(0, 200)}`); return !!element.querySelector('.review-change-diff'); });
      element.scrollIntoView({ block: 'nearest' });
      await wait(sessionId, native, () => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; });
      if (element.querySelector('.review-change-rollback')) denied('NATIVE_READONLY', 'Display unexpectedly exposed a rollback action');
      return element;
    } catch (error) { unmount(); throw error; }
  };
  return {
    inspect,
    async probe(sessionId: string, workspacePath: string, presentation: NativePresentation): Promise<ProbeEvidence> {
      alive(); if (probing) denied('NATIVE_BUSY', 'A native preflight is already running'); probing = true;
      try {
      const native = await inspect(), state = guard(sessionId, native);
      // Inspect only matching tool metadata in current renderer memory; never list/fetch ordinary session history.
      const candidates = native.records(state.messages).filter(record => record.change.path === workspacePath);
      if (state.isRunning) denied('NATIVE_RUNNING', 'Wait until the Agent finishes before running the native preflight');
      if (candidates.length !== 1) denied('NATIVE_RECORD', 'Exactly one current native record for the preflight file is required');
      native.store.getState().openWorkPanelTabForSession(sessionId, native.tab('review'));
      await wait(sessionId, native, () => !!pane()?.querySelector('.review-scroll > section.review-change-card'));
      const header = locate(native, candidates[0].change, sessionId);
      await wait(sessionId, native, () => header.getAttribute('aria-expanded') === 'true' && !!header.parentElement?.querySelector('.review-change-card-body'));
      const element = await show(native, sessionId, presentation);
      guard(sessionId, native);
      return { opened: true, located: true, externalRendered: !!element.querySelector('.review-change-diff'), readonly: !element.querySelector('.review-change-rollback'), sessionGuard: true };
      } finally { probing = false; }
    },
    close() { closed = true; unmount(); modules = undefined; }
  };
}
export type NativeReviewAdapter = ReturnType<typeof createNativeReviewAdapter>;
