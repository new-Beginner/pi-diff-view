import React, { useEffect, useState } from 'react';
import { ensureBounded } from '../view/transport';
import type { ReplyCard, ReplyCardsPage, RunSummary, TurnSummary, UiTransport } from '../core/contracts';
import { replyTail } from '../core/reply-content';
import TurnChangeSummary from './TurnChangeSummary';
import summaryStyle from './summary-style';
import { createPluginReviewAdapter, type PluginReviewAdapter } from './plugin-review-adapter';
type Disposer = () => void;
interface DraftSnapshot { text: string; marks: unknown[]; generation: number }
export interface RendererHost {
  dispatch<T = unknown>(action: string, payload?: unknown): Promise<T>;
  ui: { injectStyle(css: string): Disposer };
  slots: { register(options: { slot: 'entryExtra'; component: React.ComponentType<any> }): Disposer };
  composer: { subscribeDraft(listener: (draft: DraftSnapshot | null) => void): Disposer };
}
export interface ReplyProps { sessionId: string; messageId: string; message: { content: unknown; createdAt?: string | number } }
type CardItem = { props: ReplyProps; listeners: Set<(card: ReplyCard | null) => void>; checkedRevision?: string };
type Feed = { revision?: string; pending: number[] };
interface Hub {
  transport: UiTransport; disposed: boolean; timer?: ReturnType<typeof setTimeout>; pumping: boolean; wakeAgain: boolean;
  appearance: { locale: string; base: 'light' | 'dark' }; listeners: Set<() => void>;
  cards: Map<string, CardItem>; cache: Map<string, ReplyCard>; feeds: Map<string, Feed>;
  activeSession?: string | null; sessionVersion: number; sessionReady?: Promise<void>; unsubscribeSession?: Disposer; adapter: PluginReviewAdapter;
  reported: Set<string>;
}
let hub: Hub | null = null;
const realm = globalThis as typeof globalThis & { __piDiffRenderer?: { hub: Hub; dispose: Disposer } };
const disposers: Disposer[] = [];
const cardKey = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId]);
const timestamp = (props: ReplyProps) => typeof props.message.createdAt === 'number' ? props.message.createdAt : Date.parse(props.message.createdAt ?? '');
function same(current: Hub | null): current is Hub { return Boolean(current && current === hub && !current.disposed); }
function report(current: Hub, stage: string): void {
  if (!same(current) || current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke('rendererReport', { stage }).catch(() => {});
}
function trackSession(current: Hub): Promise<void> {
  return current.sessionReady ??= current.adapter.subscribeSession(sessionId => {
    if (same(current) && current.activeSession !== sessionId) {
      current.activeSession = sessionId; current.sessionVersion++;
      void current.transport.invoke('activeReviewSession', { sessionId }).catch(() => {});
    }
  }).then(dispose => {
    if (same(current)) { current.unsubscribeSession = dispose; report(current, 'session-ready'); } else dispose();
  }).catch(error => {
    if (same(current)) { current.sessionReady = undefined; report(current, 'session-source-error'); }
    throw error;
  });
}
function remember(current: Hub, card: ReplyCard): void {
  const key = cardKey(card.run.sessionId, card.messageId), previous = current.cache.get(key);
  // Keep the same summary object on unchanged refreshes so expansion and error state do not reset.
  if (previous && JSON.stringify(previous) === JSON.stringify(card)) card = previous;
  current.cache.delete(key); current.cache.set(key, card);
  let bytes = [...current.cache.values()].reduce((n, value) => n + new TextEncoder().encode(JSON.stringify(value)).length, 0);
  for (const [oldKey, value] of current.cache) {
    if (current.cache.size <= 200 && bytes <= 4 * 1024 * 1024) break;
    if (current.cards.has(oldKey)) continue;
    bytes -= new TextEncoder().encode(JSON.stringify(value)).length; current.cache.delete(oldKey);
  }
  current.cards.get(key)?.listeners.forEach(listener => listener(card));
}
async function restoreFeed(current: Hub, sessionId: string): Promise<Feed> {
  const feed = current.feeds.get(sessionId) ?? { pending: [] }; current.feeds.set(sessionId, feed);
  const first = await current.transport.invoke<ReplyCardsPage>('replyCards', { sessionId, revision: feed.revision });
  if (!same(current)) return feed;
  report(current, 'bootstrap-ok');
  if (current.appearance.locale !== first.locale || current.appearance.base !== first.base) {
    current.appearance = { locale: first.locale, base: first.base }; current.listeners.forEach(listener => listener());
  }
  if (!first.unchanged) {
    const restored = [...first.cards]; let offset = first.nextOffset;
    while (offset !== null) {
      const page = await current.transport.invoke<ReplyCardsPage>('replyCards', { sessionId, offset });
      if (!same(current)) return feed;
      if (page.revision !== first.revision || (page.nextOffset !== null && page.nextOffset <= offset)) throw new Error('Card history changed during paging; refresh required');
      restored.push(...page.cards); offset = page.nextOffset;
    }
    const keys = new Set(restored.map(card => cardKey(sessionId, card.messageId)));
    for (const [key, card] of current.cache) if (card.run.sessionId === sessionId && !keys.has(key)) {
      current.cache.delete(key); current.cards.get(key)?.listeners.forEach(listener => listener(null));
    }
    for (const card of restored) {
      if (card.run.sessionId !== sessionId || card.summary.sessionId !== sessionId || card.summary.runId !== card.run.id) throw new Error('Invalid recorded card identity');
      remember(current, card);
    }
    if (restored.length) { report(current, 'card-bound'); void trackSession(current).catch(() => {}); }
  }
  feed.revision = first.revision; feed.pending = first.pending;
  while (current.feeds.size > 32) {
    const removable = [...current.feeds.keys()].find(id => ![...current.cards.values()].some(item => item.props.sessionId === id));
    if (!removable) break; current.feeds.delete(removable);
  }
  return feed;
}
function wake(current: Hub, delay = 0): void {
  if (!same(current)) return;
  if (current.pumping) { if (!delay) current.wakeAgain = true; return; }
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => { current.timer = undefined; void refresh(current); }, delay);
}
async function refresh(current: Hub): Promise<void> {
  if (!same(current) || current.pumping) return;
  current.pumping = true; current.wakeAgain = false;
  try {
    const sessions = [...new Set([...current.cards.values()].map(item => item.props.sessionId))];
    for (const sessionId of sessions) {
      const feed = await restoreFeed(current, sessionId);
      if (!same(current)) return;
      const items = [...current.cards.values()].filter(item => item.props.sessionId === sessionId && !current.cache.has(cardKey(sessionId, item.props.messageId)) && item.checkedRevision !== feed.revision && feed.pending.some(time => Math.abs(time - timestamp(item.props)) < 3000)).sort((a, b) => timestamp(b.props) - timestamp(a.props));
      for (const item of items) {
        if (!same(current)) return;
        const response = await current.transport.invoke<{ run: RunSummary | null; summary?: TurnSummary }>('card', { sessionId, messageId: item.props.messageId, content: replyTail(String(item.props.message.content)), createdAt: new Date(timestamp(item.props)).toISOString() });
        if (!same(current)) return;
        item.checkedRevision = feed.revision;
        if (response.run && response.summary) {
          remember(current, { messageId: item.props.messageId, run: response.run, summary: response.summary });
          report(current, 'card-bound'); void trackSession(current).catch(() => {});
          break; // The binding changes the feed revision; refresh before matching another task.
        }
      }
    }
  } catch { if (same(current)) report(current, 'card-query-error'); }
  finally {
    current.pumping = false;
    // Refresh metadata for newly finished tasks and explicit history clearing; existing cards stay visible.
    if (same(current) && current.cards.size) wake(current, current.wakeAgain ? 0 : 2000);
  }
}
function EntryExtra(props: ReplyProps) {
  const current = hub, key = cardKey(props.sessionId, props.messageId);
  const [value, setValue] = useState<{ key: string; card: ReplyCard | null }>(() => ({ key, card: current?.cache.get(key) ?? null }));
  const [, redraw] = useState(0);
  const contentKey = props.message?.content;
  useEffect(() => {
    if (!same(current)) return;
    const listener = () => redraw(count => count + 1); current.listeners.add(listener);
    return () => { current.listeners.delete(listener); };
  }, [current]);
  useEffect(() => {
    if (!same(current) || !props.sessionId || !props.messageId || typeof contentKey !== 'string' || !contentKey || !Number.isFinite(timestamp(props))) return;
    report(current, 'reply-slot-mounted');
    let item = current.cards.get(key);
    if (!item) { item = { props, listeners: new Set() }; current.cards.set(key, item); }
    else { item.props = props; item.checkedRevision = undefined; }
    const listener = (card: ReplyCard | null) => setValue({ key, card });
    item.listeners.add(listener); listener(current.cache.get(key) ?? null); wake(current);
    return () => {
      item!.listeners.delete(listener);
      if (!item!.listeners.size) current.cards.delete(key);
      // Only unmount the DOM: keep validated cached cards for session switches and transcript windowing.
      if (!current.cards.size && current.timer) { clearTimeout(current.timer); current.timer = undefined; }
    };
  }, [current, key, contentKey, props.message?.createdAt]);
  const card = value.key === key ? value.card : current?.cache.get(key);
  if (!card || !same(current)) return null;
  const run = card.run;
  return <TurnChangeSummary run={run} initialSummary={card.summary} transport={current.transport} locale={current.appearance.locale} base={current.appearance.base} onOpen={async file => {
    await trackSession(current); const version = current.sessionVersion;
    const guard = () => { if (!same(current) || current.activeSession !== run.sessionId || current.sessionVersion !== version) throw new Error('会话已切换，请在当前会话点击 / Session changed'); };
    guard();
    const selection = await current.transport.invoke<{ nonce: string }>('selectTurn', { sessionId: run.sessionId, runId: run.id, fileId: file?.id });
    guard(); await current.adapter.open(run.sessionId, `diff-view:${selection.nonce}`); guard(); report(current, 'sidebar-opened');
  }} />;
}
export function onLoad(pi: RendererHost, options: { adapter?: PluginReviewAdapter } = {}) {
  realm.__piDiffRenderer?.dispose(); onUnload();
  const transport = ensureBounded({ invoke<T>(method: string, args?: unknown) { if (!same(current)) return Promise.reject(new Error('Renderer unloaded / 渲染扩展已卸载。')); return pi.dispatch<T>('plugin.call', { method, args }); } });
  const current: Hub = { transport, disposed: false, pumping: false, wakeAgain: false, appearance: { locale: 'zh-CN', base: 'light' }, listeners: new Set(), cards: new Map(), cache: new Map(), feeds: new Map(), sessionVersion: 0, reported: new Set(), adapter: options.adapter ?? createPluginReviewAdapter() };
  hub = current; realm.__piDiffRenderer = { hub: current, dispose: onUnload };
  disposers.push(pi.ui.injectStyle(summaryStyle)); disposers.push(pi.slots.register({ slot: 'entryExtra', component: EntryExtra }));
  report(current, 'entry-loaded');
}
export function onUnload() {
  const current = hub;
  if (current) { current.disposed = true; if (current.timer) clearTimeout(current.timer); current.unsubscribeSession?.(); current.cards.clear(); current.cache.clear(); current.feeds.clear(); current.listeners.clear(); current.adapter.close(); }
  for (const dispose of disposers.splice(0).reverse()) dispose();
  if (realm.__piDiffRenderer?.hub === current) delete realm.__piDiffRenderer;
  hub = null;
}
