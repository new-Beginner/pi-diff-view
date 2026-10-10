import React, { useEffect, useState } from 'react';
import { ensureBounded } from '../view/transport';
import type { Bootstrap, RunSummary, UiTransport } from '../core/contracts';
import TurnChangeSummary from './TurnChangeSummary';
import summaryStyle from './summary-style';
import { createPluginReviewAdapter, type PluginReviewAdapter } from './plugin-review-adapter';
import type { NativeBuildInfo } from '../core/native-build-contract';
type Disposer = () => void;
interface DraftSnapshot { sessionId?: string; text?: string }
export interface RendererHost {
  dispatch<T = unknown>(action: string, payload?: unknown): Promise<T>;
  ui: { injectStyle(css: string): Disposer };
  slots: { register(options: { slot: 'entryExtra'; component: React.ComponentType<any> }): Disposer };
  composer: { subscribeDraft(listener: (draft: DraftSnapshot) => void): Disposer };
}
export interface ReplyProps { sessionId: string; messageId: string; message: { content: unknown; createdAt?: string | number } }
type CardItem = { props: ReplyProps; listeners: Set<(run: RunSummary | null) => void>; run: RunSummary | null; checked: boolean };
interface Hub {
  host: RendererHost; transport: UiTransport; disposed: boolean; timer?: ReturnType<typeof setTimeout>;
  bootstrap: Bootstrap | null; listeners: Set<(boot: Bootstrap | null) => void>; cards: Map<string, CardItem>; cursor: number;
  activeSession?: string; unsubscribeDraft?: Disposer; adapter: PluginReviewAdapter;
  reported: Set<string>; bootstrapError?: string;
}
let hub: Hub | null = null;
const realm = globalThis as typeof globalThis & { __piDiffRenderer?: { hub: Hub; dispose: Disposer } };
const disposers: Disposer[] = [];
function same(current: Hub | null): current is Hub { return Boolean(current && current === hub && !current.disposed); }
function report(current: Hub, stage: string): void {
  if (!same(current) || current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke('rendererReport', { stage }).catch(() => {});
}
async function poll(current: Hub) {
  let bootstrapSucceeded = false;
  if (!same(current)) return;
  try {
    const data = await current.transport.invoke<Bootstrap>('bootstrap');
    if (!same(current)) return;
    current.bootstrapError = ''; report(current, 'bootstrap-ok'); bootstrapSucceeded = true;
    current.bootstrap = data; current.listeners.forEach(listener => listener(data));
    const items = [...current.cards.values()].filter(item => item.listeners.size && (!item.checked || !item.run || item.run.state === 'running'));
    for (let index = 0; index < Math.min(2, items.length); index++) {
      const item = items[(current.cursor + index) % items.length];
      const response = await current.transport.invoke<{ run: RunSummary | null }>('card', { sessionId: item.props.sessionId, messageId: item.props.messageId, content: item.props.message.content, createdAt: typeof item.props.message.createdAt === 'number' ? new Date(item.props.message.createdAt).toISOString() : item.props.message.createdAt });
      if (!same(current)) return;
      item.run = response.run; item.checked = true; item.listeners.forEach(listener => listener(response.run));
    }
    current.cursor += 2;
  } catch (error) {
    if (same(current) && !bootstrapSucceeded) { current.bootstrapError = String((error as Error).message ?? error).slice(0, 240); report(current, 'bootstrap-error'); current.listeners.forEach(listener => listener(current.bootstrap)); }
  } finally { if (same(current)) current.timer = setTimeout(() => void poll(current), 6000); }
}
function useBootstrap(current: Hub | null) {
  const [boot, setBoot] = useState(current?.bootstrap ?? null);
  useEffect(() => { if (!same(current)) return; const listener = (data: Bootstrap | null) => setBoot(data); setBoot(current.bootstrap); current.listeners.add(listener); return () => { current.listeners.delete(listener); }; }, [current]);
  return boot;
}
function EntryExtra(props: ReplyProps) {
  const current = hub; const boot = useBootstrap(current);
  const [run, setRun] = useState<RunSummary | null>(null);
  const contentKey = JSON.stringify(props.message?.content);
  useEffect(() => {
    setRun(null);
    if (!same(current) || !props.sessionId || !props.messageId || typeof props.message?.content !== 'string' || !props.message.createdAt || !contentKey || new TextEncoder().encode(contentKey).length > 40000) return;
    const key = `${props.sessionId}:${props.messageId}:${contentKey}`;
    let item = current.cards.get(key);
    if (!item) { item = { props, listeners: new Set(), run: null, checked: false }; current.cards.set(key, item); }
    item.listeners.add(setRun); setRun(item.run);
    return () => { item!.listeners.delete(setRun); if (!item!.listeners.size) current.cards.delete(key); };
  }, [current, props.sessionId, props.messageId, contentKey, props.message?.createdAt]);
  if (!run || run.state === 'running' || !same(current)) return null;
  return <TurnChangeSummary run={run} transport={current.transport} locale={boot?.locale ?? 'zh-CN'} base={boot?.base ?? 'light'} onOpen={async file => {
    const guard = () => { if (!same(current) || current.activeSession !== run.sessionId) throw new Error('会话已切换，请在当前会话点击 / Session changed'); };
    guard();
    const selection = await current.transport.invoke<{ nonce: string }>('selectTurn', { sessionId: run.sessionId, runId: run.id, fileId: file?.id });
    guard(); await current.adapter.open(run.sessionId, `diff-view:${selection.nonce}`); guard(); report(current, 'sidebar-opened');
  }} />;
}
export function onLoad(pi: RendererHost, options: { adapter?: PluginReviewAdapter } = {}) {
  realm.__piDiffRenderer?.dispose(); onUnload();
  const transport = ensureBounded({ invoke<T>(method: string, args?: unknown) { if (!same(current)) return Promise.reject(new Error('Renderer unloaded / 渲染扩展已卸载。')); return pi.dispatch<T>('plugin.call', { method, args }); } });
  const current: Hub = { host: pi, transport, disposed: false, bootstrap: null, listeners: new Set(), cards: new Map(), cursor: 0, reported: new Set(), adapter: options.adapter ?? createPluginReviewAdapter({ info: () => transport.invoke<NativeBuildInfo>('nativeProbeInfo') }) };
  hub = current; realm.__piDiffRenderer = { hub: current, dispose: onUnload };
  current.unsubscribeDraft = pi.composer.subscribeDraft(draft => { if (same(current) && current.activeSession !== draft?.sessionId) { current.activeSession = draft?.sessionId; void transport.invoke('activeReviewSession', { sessionId: draft?.sessionId ?? null }).catch(() => {}); } });
  disposers.push(pi.ui.injectStyle(summaryStyle));
  disposers.push(pi.slots.register({ slot: 'entryExtra', component: EntryExtra }));
  report(current, 'entry-loaded'); void poll(current);
}
export function onUnload() {
  const current = hub;
  if (current) { current.disposed = true; if (current.timer) clearTimeout(current.timer); current.unsubscribeDraft?.(); current.cards.clear(); current.listeners.clear(); current.adapter.close(); }
  for (const dispose of disposers.splice(0).reverse()) dispose();
  if (realm.__piDiffRenderer?.hub === current) delete realm.__piDiffRenderer;
  hub = null;
}
