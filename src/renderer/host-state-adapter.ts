import React from 'react';
import { transcriptEvidence, evidenceRevision, hostEvidenceMessages } from '../core/host-transcript';
import { collectDelegations } from '../core/delegation-lifecycle';
import type { NativeBuildInfo } from '../core/native-build-contract';
interface State {
  activeSessionId?: string | null; selectingSessionId?: string | null;
  page?: string; isRunning?: boolean; runningSessions?: Record<string, boolean>;
  agentStatuses?: Record<string, { currentTurnId?: string }>;
  sessions?: { id: string; projectPath?: string }[]; activeProjectPath?: string;
  messages?: ({ id: string; role: string; createdAt?: string | number; steering?: boolean; parentToolCallId?: string } & Record<string, any>)[];
  retainedTranscripts?: Record<string, State['messages']>;
}
export interface PluginReviewModules {
  store: { getState(): State; subscribe?(listener: (state: State) => void): () => void };
  hostReact: Pick<typeof React, 'createElement' | 'useState'>;
}
export class PluginReviewError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export interface RunningActivity { sessionId: string; taskId: string; since: number; turnId?: string }
export interface SessionContext { sessionId: string; root?: string; running: boolean; mainRunning?: boolean; statusKnown?: boolean; taskId?: string; since?: number; turnId?: string; evidence?: string; evidenceRevision?: string }
export function activityDiagnostic(state: State): 'running-idle' | 'running-identity-missing' | 'running-ready' {
  const id = state.activeSessionId;
  if (!id || state.selectingSessionId || state.page !== 'chat') return 'running-idle';
  if (runningActivity(state)) return 'running-ready';
  if (state.runningSessions?.[id] !== true) return 'running-idle';
  return (runningActivity(state)?.since ?? 0) > 0 ? 'running-ready' : 'running-identity-missing';
}
export function runningActivity(state: State): RunningActivity | null {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.selectingSessionId || state.page !== 'chat') return null;
  if (state.runningSessions?.[sessionId] !== true) {
    const rows = new Map((state.retainedTranscripts?.[sessionId] ?? []).map(message => [message.id, message]));
    for (const message of state.messages ?? []) rows.set(message.id, message);
    const time = (value: unknown) => { const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0; return Number.isSafeInteger(n) && n > 0 ? n : 0; };
    const messageTime = (message: ReturnType<typeof hostEvidenceMessages>[number]) => time(message.createdAt) || time(message.blocks.find(block => block.name === 'task')?.result?.details?.startedAt);
    const messages = hostEvidenceMessages([...rows.values()]).sort((a, b) => messageTime(a) - messageTime(b));
    const owners = new Set(collectDelegations(messages).filter(child => child.status === 'running').map(child => child.owner));
    const user = messages.filter(message => message.role === 'user' && owners.has(message.id) && !message.meta.parentMessageId).at(-1);
    const since = user ? time(user.createdAt) : 0;
    return user && Number.isSafeInteger(since) && since > 0 && since <= Date.now() ? { sessionId, taskId: user.id, since } : null;
  }
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
// Private minified exports remain limited to evidence and activity reads.
export function resolvePluginReviewModules(module: Record<string, unknown>): PluginReviewModules {
  return { store: module.R as PluginReviewModules['store'], hostReact: module.r as PluginReviewModules['hostReact'] };
}
async function loadPinned(): Promise<PluginReviewModules> {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).map(script => script.src);
  const main = hostEntryUrl(document.location.href, scripts);
  // Reuses the very same module already executing in this document, never a copied main entry.
  const module = await import(/* @vite-ignore */ main);
  return resolvePluginReviewModules(module);
}
/** Remaining private compatibility path: running metadata and transcript evidence only. */
export function createHostStateAdapter(options: { info?: () => Promise<NativeBuildInfo>; load?: () => Promise<PluginReviewModules> } = {}) {
  let closed = false, pending: Promise<PluginReviewModules> | undefined;
  const subscriptions = new Set<() => void>();
  const alive = () => { if (closed) denied('SIDEBAR_UNLOADED', '插件已卸载 / Plugin unloaded'); };
  const inspect = () => pending ??= (async () => {
    alive();
    const result = await (options.load ?? loadPinned)(); alive();
    if (typeof result.store?.getState !== 'function' || result.hostReact?.createElement !== React.createElement || result.hostReact?.useState !== React.useState) denied('SIDEBAR_CONTRACT', '宿主证据接口已变化 / Host evidence contract changed');
    return result;
  })().catch(error => { pending = undefined; throw error; });
  return {
    async subscribeEvidence(listener: (sessionId: string | null, context?: SessionContext) => void): Promise<() => void> {
      const modules = await inspect(); alive();
      if (typeof modules.store.subscribe !== 'function') return denied('SIDEBAR_CONTRACT', '宿主会话订阅接口已变化 / Host session subscription unavailable');
      let previous: string | undefined, stopped = false;
      const publish = (state: State) => {
        if (closed || stopped) return;
        const sessionId = state.selectingSessionId ? null : state.activeSessionId ?? null;
        if (sessionId !== null && typeof sessionId !== 'string') denied('SIDEBAR_CONTRACT', '无效的宿主会话状态 / Invalid host session state');
        const activity = runningActivity(state);
        const context: SessionContext | undefined = sessionId ? { sessionId, root: state.sessions?.find(s => s.id === sessionId)?.projectPath, running: state.runningSessions?.[sessionId] === true || activity !== null, mainRunning: state.runningSessions?.[sessionId] === true, statusKnown: typeof state.runningSessions?.[sessionId] === 'boolean', taskId: activity?.taskId, since: activity?.since, turnId: activity?.turnId } : undefined;
        if (context) {
          const rows = new Map((state.retainedTranscripts?.[sessionId!] ?? []).map(m => [m.id, m]));
          for (const m of state.messages ?? []) rows.set(m.id, m);
          context.evidence = transcriptEvidence([...rows.values()]);
          context.evidenceRevision = evidenceRevision(context.evidence);
        }
        const key = JSON.stringify([sessionId, context && { ...context, evidence: undefined }]);
        if (key !== previous) { previous = key; listener(sessionId, context); }
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
    close() { closed = true; for (const dispose of [...subscriptions]) dispose(); }
  };
}
