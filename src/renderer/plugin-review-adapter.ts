import React from 'react';
import { transcriptEvidence, evidenceRevision } from '../core/host-transcript';
import type { NativeBuildInfo } from '../core/native-build-contract';
export const REVIEW_TAB_ID = 'plugin:local.diff-view/review';
interface Tab { id: string; kind: string; resource: string; location?: string; }
interface State {
  activeSessionId?: string | null; selectingSessionId?: string | null;
  page?: string; isRunning?: boolean; runningSessions?: Record<string, boolean>;
  agentStatuses?: Record<string, { currentTurnId?: string }>;
  sessions?: { id: string; projectPath?: string }[]; activeProjectPath?: string;
  messages?: ({ id: string; role: string; createdAt?: string | number; steering?: boolean; parentToolCallId?: string } & Record<string, any>)[];
  retainedTranscripts?: Record<string, State['messages']>;
  workPanelOpen: boolean; activeWorkPanelTabId: string | null;
  workPanelTabs?: Tab[];
  pluginViews: { pluginId: string; viewId: string }[];
  openWorkPanelTabForSession(sessionId: string, tab: Tab): void;
}
export interface PluginReviewModules {
  store: { getState(): State; subscribe?(listener: (state: State) => void): () => void };
  tab(pluginId: string, viewId: string): Tab;
  hostReact: Pick<typeof React, 'createElement' | 'useState'>;
}
export class PluginReviewError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export interface RunningActivity { sessionId: string; taskId: string; since: number; turnId?: string }
export interface SessionContext { sessionId: string; root?: string; running: boolean; taskId?: string; since?: number; turnId?: string; evidence?: string; evidenceRevision?: string }
export function activityDiagnostic(state: State): 'running-idle' | 'running-identity-missing' | 'running-ready' {
  const id = state.activeSessionId;
  if (!id || state.selectingSessionId || state.page !== 'chat' || (state.runningSessions?.[id] ?? state.isRunning) !== true) return 'running-idle';
  return (runningActivity(state)?.since ?? 0) > 0 ? 'running-ready' : 'running-identity-missing';
}
export function runningActivity(state: State): RunningActivity | null {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.selectingSessionId || state.page !== 'chat' || (state.runningSessions?.[sessionId] ?? state.isRunning) !== true) return null;
  // Read metadata only. The visible transcript can be windowed to an older section.
  const sources = [state.messages ?? [], state.retainedTranscripts?.[sessionId] ?? []].map(messages => messages.filter(message => message.role === 'user' && !message.steering && !message.parentToolCallId));
  const users = sources.flat();
  const time = (message: typeof users[number]) => { const value = typeof message.createdAt === 'number' ? message.createdAt : Date.parse(message.createdAt ?? ''); return Number.isSafeInteger(value) && value > 0 ? value : 0; };
  const turnId = state.agentStatuses?.[sessionId]?.currentTurnId;
  const unavailable = () => turnId ? { sessionId, taskId: `turn:${turnId}`, since: 0, turnId } : null;
  // Never fall back to an older task if the latest source user cannot be identified.
  for (const source of sources) { const last = source.at(-1); if (last && (!last.id || !time(last)) && !users.some(other => other.id === last.id && time(other) > 0)) return unavailable(); }
  users.sort((a, b) => time(b) - time(a));
  const user = users[0], since = user ? time(user) : 0;
  if (!user?.id || since <= 0 || since > Date.now()) return unavailable();
  if (users.some(other => time(other) === since && other.id !== user.id)) return null;
  return { sessionId, taskId: user.id, since, turnId };
}
const denied = (code: string, message: string): never => { throw new PluginReviewError(code, message); };
export function hostEntryUrl(documentUrl: string, scriptUrls: string[]): string {
  const page = new URL(documentUrl);
  if (page.protocol !== 'file:') denied('SIDEBAR_ORIGIN', '不是本地宿主页 / Not a local host document');
  const assets = new URL('assets/', page);
  const entries = scriptUrls.map(url => new URL(url, page)).filter(url => url.protocol === 'file:' && url.host === assets.host && url.pathname.startsWith(assets.pathname) && /^index(?:-[^/]+)?\.js$/.test(url.pathname.slice(assets.pathname.length)));
  if (entries.length !== 1) denied('SIDEBAR_ENTRY', '宿主主模块缺失或不唯一 / Host entry module missing or ambiguous');
  return entries[0].href;
}
// The host tab DTO is stable; its minified factory export is not.
export function resolvePluginReviewModules(module: Record<string, unknown>): PluginReviewModules {
  return {
    store: module.R as PluginReviewModules['store'],
    hostReact: module.r as PluginReviewModules['hostReact'],
    tab: (pluginId, viewId) => { const resource = `${pluginId}/${viewId}`; return { id: `plugin:${resource}`, kind: 'plugin', resource }; }
  };
}
async function loadPinned(): Promise<PluginReviewModules> {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).map(script => script.src);
  const main = hostEntryUrl(document.location.href, scripts);
  // Reuses the very same module already executing in this document, never a copied main entry.
  const module = await import(/* @vite-ignore */ main);
  return resolvePluginReviewModules(module);
}
export function createPluginReviewAdapter(options: { info?: () => Promise<NativeBuildInfo>; load?: () => Promise<PluginReviewModules> } = {}) {
  let closed = false, pending: Promise<PluginReviewModules> | undefined;
  const subscriptions = new Set<() => void>();
  const alive = () => { if (closed) denied('SIDEBAR_UNLOADED', '插件已卸载 / Plugin unloaded'); };
  const inspect = () => pending ??= (async () => {
    alive();
    const result = await (options.load ?? loadPinned)(); alive();
    if (typeof result.store?.getState !== 'function' || typeof result.tab !== 'function' || result.hostReact?.createElement !== React.createElement || result.hostReact?.useState !== React.useState) denied('SIDEBAR_CONTRACT', '宿主页签接口已变化 / Host tab contract changed');
    const tab = result.tab('local.diff-view', 'review');
    if (tab.id !== REVIEW_TAB_ID || tab.kind !== 'plugin' || tab.resource !== 'local.diff-view/review') denied('SIDEBAR_CONTRACT', '插件页签标识不匹配 / Plugin tab identity mismatch');
    return result;
  })().catch(error => { pending = undefined; throw error; });
  return {
    async subscribeSession(listener: (sessionId: string | null, context?: SessionContext) => void): Promise<() => void> {
      const modules = await inspect(); alive();
      if (typeof modules.store.subscribe !== 'function') return denied('SIDEBAR_CONTRACT', '宿主会话订阅接口已变化 / Host session subscription unavailable');
      let previous: string | undefined, stopped = false;
      const publish = (state: State) => {
        if (closed || stopped) return;
        const sessionId = state.selectingSessionId ? null : state.activeSessionId ?? null;
        if (sessionId !== null && typeof sessionId !== 'string') denied('SIDEBAR_CONTRACT', '无效的宿主会话状态 / Invalid host session state');
        const activity = runningActivity(state);
        const context: SessionContext | undefined = sessionId ? { sessionId, root: state.sessions?.find(s => s.id === sessionId)?.projectPath, running: (state.runningSessions?.[sessionId] ?? state.isRunning) === true, taskId: activity?.taskId, since: activity?.since, turnId: activity?.turnId } : undefined;
        if (context) {
          const rows = new Map((state.retainedTranscripts?.[sessionId!] ?? []).map(m => [m.id, m]));
          for (const m of state.messages ?? []) rows.set(m.id, m);
          context.evidence = transcriptEvidence([...rows.values()]);
          context.evidenceRevision = evidenceRevision(context.evidence);
        }
        const key = JSON.stringify([sessionId, context && { ...context, evidence: undefined }]);
        if (key !== previous) { previous = key; listener(sessionId, context); }
        const tab = state.workPanelTabs?.find(t => t.id === REVIEW_TAB_ID);
        if (sessionId && tab && state.workPanelOpen && state.activeWorkPanelTabId === REVIEW_TAB_ID) {
          const suffix = `?sessionId=${encodeURIComponent(sessionId)}`;
          if (!tab.location?.endsWith(suffix)) state.openWorkPanelTabForSession(sessionId, { ...tab, location: `diff-session:${encodeURIComponent(sessionId)}${suffix}` });
        }
      };
      const unsubscribe = modules.store.subscribe(publish);
      const dispose = () => { if (!stopped) { stopped = true; subscriptions.delete(dispose); unsubscribe(); } };
      subscriptions.add(dispose);
      try { publish(modules.store.getState()); return dispose; } catch (error) { dispose(); throw error; }
    },
    async subscribeActivity(listener: (activity: RunningActivity | null) => void, diagnose?: (stage: string) => void): Promise<() => void> {
      const modules = await inspect(); alive();
      if (typeof modules.store.subscribe !== 'function') return denied('SIDEBAR_CONTRACT', 'Host activity subscription unavailable');
      let previous: string | undefined, stopped = false;
      const publish = (state: State) => {
        if (closed || stopped) return;
        const activity = runningActivity(state), key = JSON.stringify(activity);
        if (key !== previous) { previous = key; diagnose?.(activityDiagnostic(state)); listener(activity); }
      };
      const unsubscribe = modules.store.subscribe(publish);
      const dispose = () => { if (!stopped) { stopped = true; subscriptions.delete(dispose); unsubscribe(); } };
      subscriptions.add(dispose);
      try { publish(modules.store.getState()); return dispose; } catch (error) { dispose(); throw error; }
    },
    async open(sessionId: string, location: string, guard?: () => void): Promise<void> {
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied('SIDEBAR_TARGET', '无效的插件定位令牌 / Invalid selection token');
      location = `${location}?sessionId=${encodeURIComponent(sessionId)}`;
      const modules = await inspect(); alive(); guard?.(); const state = modules.store.getState();
      if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied('SIDEBAR_SESSION', '会话已切换，请在当前会话点击 / Session changed');
      if (!Array.isArray(state.pluginViews) || !state.pluginViews.some(view => view.pluginId === 'local.diff-view' && view.viewId === 'review')) denied('SIDEBAR_VIEW', 'Diff view 页签不可用，请检查插件是否启用 / Diff view tab unavailable');
      if (typeof state.openWorkPanelTabForSession !== 'function') denied('SIDEBAR_CONTRACT', '宿主不支持打开插件页签 / Plugin tab opener unavailable');
      const existing = state.workPanelTabs?.find(tab => tab.id === REVIEW_TAB_ID && tab.kind === 'plugin' && tab.resource === 'local.diff-view/review' && tab.location === location);
      if (existing && state.workPanelOpen && state.activeWorkPanelTabId === REVIEW_TAB_ID) return;
      state.openWorkPanelTabForSession(sessionId, existing ?? { ...modules.tab('local.diff-view', 'review'), location });
      const opened = modules.store.getState();
      if (opened.activeSessionId !== sessionId || !opened.workPanelOpen || opened.activeWorkPanelTabId !== REVIEW_TAB_ID) denied('SIDEBAR_OPEN', '侧栏未打开 / Sidebar did not open');
    },
    close() { closed = true; for (const dispose of [...subscriptions]) dispose(); }
  };
}
export type PluginReviewAdapter = ReturnType<typeof createPluginReviewAdapter>;
