import React from 'react';
import { matchesNativeBuild, type NativeBuildInfo } from '../core/native-build-contract';
import { pinnedModuleUrls } from './native-review-adapter';
export const REVIEW_TAB_ID = 'plugin:local.diff-view/review';
interface Tab { id: string; kind: string; resource: string; location?: string; }
interface State {
  activeSessionId: string | null; selectingSessionId?: string | null;
  workPanelOpen: boolean; activeWorkPanelTabId: string | null;
  pluginViews: { pluginId: string; viewId: string }[];
  openWorkPanelTabForSession(sessionId: string, tab: Tab): void;
}
export interface PluginReviewModules {
  store: { getState(): State };
  tab(pluginId: string, viewId: string): Tab;
  hostReact: Pick<typeof React, 'createElement' | 'useState'>;
}
export class PluginReviewError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const denied = (code: string, message: string): never => { throw new PluginReviewError(code, message); };
async function loadPinned(): Promise<PluginReviewModules> {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).map(script => script.src);
  const { main } = pinnedModuleUrls(document.location.href, scripts);
  // Reuses the very same module already executing in this document, never a copied main entry.
  const module = await import(/* @vite-ignore */ main);
  return { store: module.R, tab: module.aO, hostReact: module.r };
}
export function createPluginReviewAdapter(options: { info(): Promise<NativeBuildInfo>; load?: () => Promise<PluginReviewModules> }) {
  let closed = false, pending: Promise<PluginReviewModules> | undefined;
  const alive = () => { if (closed) denied('SIDEBAR_UNLOADED', '插件已卸载 / Plugin unloaded'); };
  const inspect = () => pending ??= (async () => {
    alive(); const info = await options.info(); alive();
    if (!info.supported || !matchesNativeBuild(info.version, info.hashes)) denied('SIDEBAR_BUILD', info.reason ?? '不支持当前宿主构建 / Unsupported host build');
    const result = await (options.load ?? loadPinned)(); alive();
    if (typeof result.store?.getState !== 'function' || typeof result.tab !== 'function' || result.hostReact?.createElement !== React.createElement || result.hostReact?.useState !== React.useState) denied('SIDEBAR_CONTRACT', '宿主页签接口已变化 / Host tab contract changed');
    const tab = result.tab('local.diff-view', 'review');
    if (tab.id !== REVIEW_TAB_ID || tab.kind !== 'plugin' || tab.resource !== 'local.diff-view/review') denied('SIDEBAR_CONTRACT', '插件页签标识不匹配 / Plugin tab identity mismatch');
    return result;
  })();
  return {
    async open(sessionId: string, location: string): Promise<void> {
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied('SIDEBAR_TARGET', '无效的插件定位令牌 / Invalid selection token');
      const modules = await inspect(); alive(); const state = modules.store.getState();
      if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied('SIDEBAR_SESSION', '会话已切换，请在当前会话点击 / Session changed');
      if (!Array.isArray(state.pluginViews) || !state.pluginViews.some(view => view.pluginId === 'local.diff-view' && view.viewId === 'review')) denied('SIDEBAR_VIEW', 'Diff view 页签不可用，请检查插件是否启用 / Diff view tab unavailable');
      if (typeof state.openWorkPanelTabForSession !== 'function') denied('SIDEBAR_CONTRACT', '宿主不支持打开插件页签 / Plugin tab opener unavailable');
      state.openWorkPanelTabForSession(sessionId, { ...modules.tab('local.diff-view', 'review'), location });
      const opened = modules.store.getState();
      if (opened.activeSessionId !== sessionId || !opened.workPanelOpen || opened.activeWorkPanelTabId !== REVIEW_TAB_ID) denied('SIDEBAR_OPEN', '侧栏未打开 / Sidebar did not open');
    },
    close() { closed = true; }
  };
}
export type PluginReviewAdapter = ReturnType<typeof createPluginReviewAdapter>;
