import React, { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReviewApp from '../view/ReviewApp';
import { ensureBounded } from '../view/transport';
import { messages } from '../view/i18n';
import type { Bootstrap, RunSummary, UiTransport } from '../core/contracts';
import reviewStyle from './styles';
import { createNativeReviewAdapter, type NativeReviewAdapter } from './native-review-adapter';
import type { NativeBuildInfo } from '../core/native-build-contract';

type Disposer = () => void;
interface DraftSnapshot { sessionId?: string; text?: string }
export interface RendererHost {
  dispatch<T = unknown>(action: string, payload?: unknown): Promise<T>;
  ui: { injectStyle(css: string): Disposer; openLayer(): { element: HTMLElement; close: Disposer } };
  slots: { register(options: { slot: 'entryExtra' | 'composerControl'; component: React.ComponentType<any>; positions?: ['right'] }): Disposer };
  composer: { subscribeDraft(listener: (draft: DraftSnapshot) => void): Disposer };
}
export interface ReplyProps { sessionId: string; messageId: string; message: { content: unknown; createdAt?: string | number } }
type CardItem = { props: ReplyProps; listeners: Set<(run: RunSummary | null) => void>; run: RunSummary | null; checked: boolean };
interface Hub {
  host: RendererHost; transport: UiTransport; disposed: boolean; timer?: ReturnType<typeof setTimeout>;
  bootstrap: Bootstrap | null; listeners: Set<(boot: Bootstrap | null) => void>; cards: Map<string, CardItem>; cursor: number;
  activeSession?: string; unsubscribeDraft?: Disposer;
  native?: NativeReviewAdapter;
}
let hub: Hub | null = null;
const realm = globalThis as typeof globalThis & { __piDiffRenderer?: { hub: Hub; dispose: Disposer } };
const disposers: Disposer[] = [];
const layers = new Set<Disposer>();
const css = `${reviewStyle}\n.dv-reply{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border-top:1px solid color-mix(in srgb,currentColor 16%,transparent);padding:8px 0;font:12px/1.45 system-ui}.dv-reply button,.dv-composer{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:4px;padding:4px 8px;cursor:pointer}.dv-reply button:hover,.dv-composer:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.dv-reply button:focus-visible,.dv-composer:focus-visible{outline:2px solid #8cb9ff;outline-offset:2px}.dv-composer:disabled{opacity:.5;cursor:not-allowed}.dv-layer{position:fixed;inset:0;padding:24px;background:rgb(0 0 0 / .4);display:grid;place-items:stretch;z-index:1}.dv-layer-inner{min-width:0;min-height:0;border:1px solid #616b77;border-radius:8px;box-shadow:0 8px 32px rgb(0 0 0 / .2)}.dv-layer .dv-app{height:100%;min-height:0;border-radius:8px}.dv-layer-error{color:#b02c35;padding:8px;font:12px system-ui}@media(max-width:720px){.dv-layer{padding:8px}}`;
function same(current: Hub | null): current is Hub { return Boolean(current && current === hub && !current.disposed); }
async function poll(current: Hub) {
  if (!same(current)) return;
  try {
    const data = await current.transport.invoke<Bootstrap>('bootstrap');
    if (!same(current)) return;
    current.bootstrap = data; current.listeners.forEach(listener => listener(data));
    const items = [...current.cards.values()].filter(item => item.listeners.size && (!item.checked || !item.run || item.run.state === 'running'));
    // At most two reply lookups per 6s cycle, regardless of mounted reply count.
    for (let index = 0; index < Math.min(2, items.length); index++) {
      const item = items[(current.cursor + index) % items.length];
      const response = await current.transport.invoke<{ run: RunSummary | null }>('card', { sessionId: item.props.sessionId, messageId: item.props.messageId, content: item.props.message.content, createdAt: typeof item.props.message.createdAt === 'number' ? new Date(item.props.message.createdAt).toISOString() : item.props.message.createdAt });
      if (!same(current)) return;
      item.run = response.run; item.checked = true; item.listeners.forEach(listener => listener(response.run));
    }
    current.cursor += 2;
  } catch { /* Polling is passive; independent panel surfaces actionable backend errors. */ }
  finally { if (same(current)) current.timer = setTimeout(() => void poll(current), 6000); }
}
function useBootstrap(current: Hub | null) {
  const [boot, setBoot] = useState(current?.bootstrap ?? null);
  useEffect(() => { if (!same(current)) return; setBoot(current.bootstrap); current.listeners.add(setBoot); return () => { current.listeners.delete(setBoot); }; }, [current]);
  return boot;
}
function openReview(current: Hub, run?: RunSummary) {
  if (!same(current)) return;
  const sessionId = run?.sessionId ?? current.activeSession;
  const layer = current.host.ui.openLayer(); let mounted = true; let root: Root | null = null;
  const previous = document.activeElement as HTMLElement | null;
  const close = () => { if (!mounted) return; mounted = false; root?.unmount(); layer.close(); layers.delete(close); previous?.focus(); };
  const transport: UiTransport = { invoke: current.transport.invoke, ...(sessionId ? { insertText(text: string) {
    if (!mounted || !same(current) || current.activeSession !== sessionId) return Promise.reject(new Error('Composer session changed / 编辑器会话已切换。'));
    // Ready text only; dispatch synchronously from ReviewApp's click handler.
    return current.host.dispatch<void>('composer.insertText', { text });
  } } : {}) };
  function Layer() {
    const boot = useBootstrap(current); const shell = useRef<HTMLDivElement>(null);
    useEffect(() => { shell.current?.querySelector<HTMLElement>('button,select')?.focus(); }, []);
    return <div className="dv-layer" ref={shell} role="dialog" aria-modal="true" aria-label={messages(boot?.locale ?? 'zh-CN').title} onKeyDown={event => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('dialog')) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(shell.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}><div className="dv-layer-inner"><ReviewApp transport={transport} initialRequest={run ? { scope: 'turn', root: run.root, sessionId, runId: run.id } : { scope: 'unstaged', sessionId }} locale={boot?.locale} base={boot?.base} onClose={close} /></div></div>;
  }
  layers.add(close); root = createRoot(layer.element); root.render(<Layer />);
}
function EntryExtra(props: ReplyProps) {
  const current = hub; const boot = useBootstrap(current); const t = messages(boot?.locale ?? 'zh-CN');
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
  // No guessed binding, zero-run fabricated card, or private DOM session lookup.
  if (!run || !same(current)) return null;
  return <div className="dv-reply"><span>{t.files}: {run.fileCount}</span><span>{t[run.state]}{run.incomplete ? ` · ${t.incomplete}` : ''}</span><button onClick={() => openReview(current, run)}>{t.title}</button></div>;
}
function ComposerControl() {
  const current = hub; const boot = useBootstrap(current); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const mounted = useRef(true);
  const [probeStatus, setProbeStatus] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const t = messages(boot?.locale ?? 'zh-CN');
  return <><button className="dv-composer" disabled={busy || !same(current)} title={t.title} onClick={() => {
    if (!same(current)) return;
    setBusy(true); setError(''); try { openReview(current); } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); } finally { if (mounted.current) setBusy(false); }
  }}>{busy ? t.loading : t.title}</button>{boot?.settings.nativePreflight && <button className="dv-composer" disabled={busy || !same(current) || !current.activeSession} onClick={() => {
    if (!same(current) || !current.native || !current.activeSession) return;
    const sessionId = current.activeSession;
    setBusy(true); setProbeStatus('验证中 / Checking native integration…');
    current.native.probe(sessionId, 'docs/native-preflight-fixture.txt', { id: 'preflight-demo', path: '[外部文件演示 / render-only] native-preflight-external.txt', origin: 'external', demo: true, additions: 1, deletions: 1, hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ type: 'del', text: 'native preflight before' }, { type: 'add', text: 'native preflight after' }] }] }).then(result => {
      if (mounted.current && same(current) && current.activeSession === sessionId) setProbeStatus(`原生预检 / Native preflight: ${JSON.stringify(result)}。请人工核对侧栏；演示不是实际采集。`);
    }).catch(err => { if (mounted.current && same(current)) setProbeStatus(`原生预检未通过 / Failed: ${String(err?.code ?? 'NATIVE_IMPORT')} ${err instanceof Error ? err.message : String(err)}`); }).finally(() => { if (mounted.current && same(current)) setBusy(false); });
  }}>原生审阅预检 / Native preflight</button>}{probeStatus && <span className="dv-layer-error" role="status" style={{ whiteSpace: 'pre-wrap' }}>{probeStatus}</span>}{error && <span className="dv-layer-error" role="alert">{error}</span>}</>;
}
export function onLoad(pi: RendererHost) {
  realm.__piDiffRenderer?.dispose(); onUnload();
  const transport = ensureBounded({ invoke<T>(method: string, args?: unknown) { if (!same(current)) return Promise.reject(new Error('Renderer unloaded / 渲染扩展已卸载。')); return pi.dispatch<T>('plugin.call', { method, args }); } });
  const current: Hub = { host: pi, transport, disposed: false, bootstrap: null, listeners: new Set(), cards: new Map(), cursor: 0 };
  hub = current;
  current.native = createNativeReviewAdapter({ info: () => transport.invoke<NativeBuildInfo>('nativeProbeInfo') });
  realm.__piDiffRenderer = { hub: current, dispose: onUnload };
  current.unsubscribeDraft = pi.composer.subscribeDraft(draft => {
    if (!same(current)) return;
    const previous = current.activeSession; current.activeSession = draft?.sessionId;
    if (previous && previous !== current.activeSession) for (const dispose of [...layers]) dispose();
  });
  disposers.push(pi.ui.injectStyle(css));
  disposers.push(pi.slots.register({ slot: 'entryExtra', component: EntryExtra }));
  disposers.push(pi.slots.register({ slot: 'composerControl', component: ComposerControl, positions: ['right'] }));
  void poll(current);
}
export function onUnload() {
  const current = hub;
  if (current) { current.disposed = true; if (current.timer) clearTimeout(current.timer); current.unsubscribeDraft?.(); current.cards.clear(); current.listeners.clear(); }
  current?.native?.close();
  for (const dispose of [...layers]) dispose();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  if (realm.__piDiffRenderer?.hub === current) delete realm.__piDiffRenderer;
  hub = null;
}
