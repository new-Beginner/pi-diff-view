import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from './ReviewApp';
import { GitManagement } from './GitManagement';
import { ensureBounded } from './transport';
import type { Bootstrap, ReviewRequest, UiTransport } from '../core/contracts';
import type { ReviewNavigation } from '../core/review-navigation';
import type { SurfaceReply } from '../core/review-surfaces';
import './theme.css';
interface Appearance { locale?: string; base?: 'light' | 'dark' }
interface Bridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; on?(event: string, callback: (data: any) => void): (() => void) | void }
declare global { interface Window { pluginBridge?: Bridge } }
export function Panel() {
  const [appearance, setAppearance] = useState<Appearance>(() => ({ base: document.documentElement.dataset.base === 'dark' || (!document.documentElement.dataset.base && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light' }));
  const [route, setRoute] = useState<unknown>(() => new URLSearchParams(location.search).get('piViewOpen'));
  const [navigationBySession, setNavigationBySession] = useState<Record<string, ReviewNavigation>>({});
  const [cachedSessions, setCachedSessions] = useState<string[]>([]);
  const [error, setError] = useState(''), [selecting, setSelecting] = useState(Boolean(route));
  const [retry, setRetry] = useState(0), [fallback, setFallback] = useState(false);
  const [mode, setMode] = useState<'session' | 'git'>('session');
  const [roots, setRoots] = useState<string[]>([]), [gitRoot, setGitRoot] = useState(''), [gitError, setGitError] = useState('');
  const [gitLoaded, setGitLoaded] = useState(false);
  const readySession = useRef('');
  const resolvedSelection = useRef<Record<string, string>>({});
  const [surface, setSurface] = useState<SurfaceReply | null>(null);
  const [surfaceError, setSurfaceError] = useState('');
  const appliedSurface = useRef<string>();
  const previousSurface = useRef<string>();
  const wakeSurface = useRef<() => void>();
  const transport = useMemo<UiTransport>(() => ensureBounded({ invoke<T>(method: string, args?: unknown) {
    if (!window.pluginBridge) return Promise.reject(new Error('PI-Desktop 桥接不可用。'));
    return window.pluginBridge.invoke<T>(`diff.${method}`, args);
  } }), []);
  const effectiveRoute = surface ? surface.state === 'ready' && surface.sessionId ? `${surface.nonce ? `diff-view:${surface.nonce}` : `diff-session:${encodeURIComponent(surface.sessionId)}`}?sessionId=${encodeURIComponent(surface.sessionId)}` : '' : route;
  const [target, query = ''] = typeof effectiveRoute === 'string' ? effectiveRoute.split('?') : ['', ''];
  const sessionId = surface ? surface.state === 'ready' ? surface.sessionId ?? '' : '' : new URLSearchParams(query).get('sessionId') ?? new URLSearchParams(location.search).get('sessionId') ?? '';
  useEffect(() => {
    const id = crypto.randomUUID(); let seq = 0, live = true, pending = false, wakeAgain = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!live || pending) return;
      pending = true;
      try {
        const value = await transport.invoke<SurfaceReply>('reviewSurface', { role: 'view', id, seq: ++seq, ack: appliedSurface.current });
        if (!live || !value || !['ready', 'waiting', 'ambiguous'].includes(value.state)) return;
        setSurface(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
        setSurfaceError(value.state === 'ambiguous' ? '存在多个窗口或审查视图，无法唯一绑定；请只保留一个窗口和审查视图。' : '');
      } catch (error) { if (live) { setSurface(previous => previous ? { state: 'waiting', sessionId: null } : previous); setSurfaceError(`会话导航桥接暂不可用：${String((error as Error).message)}`); } }
      finally { pending = false; if (live) { timer = setTimeout(() => void poll(), wakeAgain ? 0 : 1500); wakeAgain = false; } }
    };
    wakeSurface.current = () => { if (!live) return; if (pending) { wakeAgain = true; return; } if (timer) clearTimeout(timer); void poll(); };
    void poll();
    return () => { live = false; wakeSurface.current = undefined; if (timer) clearTimeout(timer); void transport.invoke('reviewSurface', { role: 'view', id, seq: ++seq, release: true }).catch(() => {}); };
  }, [transport]);
  useEffect(() => {
    if (!surface?.key || previousSurface.current === surface.key) return;
    previousSurface.current = surface.key; setError(''); setFallback(false);
    if (surface.nonce) setMode('session');
  }, [surface?.key]);
  useEffect(() => {
    const dispose = window.pluginBridge?.on?.('view:open', value => {
      setError(''); setSelecting(typeof value?.path === 'string' && value.path.startsWith('diff-view:')); setFallback(false); setMode('session'); setRoute(value?.path); setRetry(n => n + 1);
    });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, []);
  useEffect(() => {
    if (mode !== 'git') return;
    let live = true; setGitError('');
    transport.invoke<Bootstrap>('bootstrap', {}).then(value => {
      if (live) { const values = value.repositories.map(r => r.root); setRoots(values); setGitRoot(previous => values.includes(previous) ? previous : values[0] ?? ''); setGitLoaded(true); }
    }).catch(err => { if (live) { setGitError(String(err.message)); setGitLoaded(true); } });
    return () => { live = false; };
  }, [mode, transport]);
  useEffect(() => {
    let live = true, changed = false;
    const update = (value: Appearance) => {
      if (!live) return;
      setAppearance(previous => ({ locale: value?.locale || previous.locale, base: value?.base === 'light' || value?.base === 'dark' ? value.base : previous.base }));
    };
    const dispose = window.pluginBridge?.on?.('appearance:changed', value => { changed = true; update(value); });
    window.pluginBridge?.invoke<Appearance>('app.getAppearance').then(value => { if (!changed) update(value); }).catch(() => undefined);
    return () => { live = false; if (typeof dispose === 'function') dispose(); };
  }, []);
  useEffect(() => {
    if (appearance.locale) document.documentElement.lang = appearance.locale;
    if (appearance.base) document.documentElement.dataset.base = appearance.base;
  }, [appearance]);
  useEffect(() => {
    let live = true, pending = false;
    setError(''); setSelecting(false);
    if (fallback || effectiveRoute == null || effectiveRoute === '') return;
    if (typeof effectiveRoute !== 'string') { setError('无效的视图定位参数'); return; }
    if (!sessionId) { setError('旧版视图没有会话标识，请从当前会话重新打开差异审查。'); return; }
    if (target === `diff-session:${encodeURIComponent(sessionId)}`) return;
    if (!/^diff-view:[0-9a-f-]{36}$/i.test(target)) { setError('无效的文件选择'); return; }
    if (mode !== 'session') return;
    const load = async () => {
      if (pending || !live) return;
      pending = true;
      try {
        const selected = await transport.invoke<ReviewNavigation>('readTurnSelection', { nonce: target.slice('diff-view:'.length), sessionId });
        if (!live) return;
        if (selected.sessionId !== sessionId || selected.request.sessionId !== sessionId) throw new Error('所选记录不属于当前会话。');
        if (surface?.selectionRevision && selected.revision !== surface.selectionRevision) throw new Error('文件选择已变化，等待新的定位请求。');
        setNavigationBySession(previous => ({ ...previous, [sessionId]: previous[sessionId]?.nonce === selected.nonce && previous[sessionId]?.revision === selected.revision ? previous[sessionId] : selected }));
        resolvedSelection.current[sessionId] = target;
        setError('');
      } catch (err) { if (live) { if (resolvedSelection.current[sessionId] !== target) setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(String((err as Error)?.message ?? err)); } }
      finally { pending = false; if (live) setSelecting(false); }
    };
    setSelecting(true); void load();
    const timer = setInterval(() => { if (mode === 'session' && document.visibilityState !== 'hidden') void load(); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [transport, effectiveRoute, target, sessionId, retry, fallback, mode, surface?.key]);
  if (sessionId && !selecting && !error) readySession.current = sessionId;
  // A transient same-target poll failure must not unmount a verified session view.
  const retainReview = readySession.current === sessionId && resolvedSelection.current[sessionId] === target;
  const targetResolved = fallback || !target.startsWith('diff-view:') || (navigationBySession[sessionId]?.nonce === target.slice('diff-view:'.length) && (!surface?.selectionRevision || navigationBySession[sessionId]?.revision === surface.selectionRevision));
  const showReview = Boolean(sessionId && targetResolved && (!error || retainReview) && (!selecting || readySession.current === sessionId));
  useEffect(() => {
    if (!surface?.key || surface.state !== 'ready' || !sessionId || !showReview || error || selecting) { appliedSurface.current = undefined; return; }
    const selected = navigationBySession[sessionId];
    if (surface.nonce && (selected?.nonce !== surface.nonce || selected.revision !== surface.selectionRevision)) return;
    if (appliedSurface.current !== surface.key) { appliedSurface.current = surface.key; wakeSurface.current?.(); }
  }, [surface?.key, sessionId, showReview, error, selecting, navigationBySession]);
  useEffect(() => {
    if (!sessionId || !showReview) return;
    setCachedSessions(previous => {
      const next = [sessionId, ...previous.filter(id => id !== sessionId)].slice(0, 6);
      return next;
    });
  }, [sessionId, showReview]);
  useEffect(() => {
    setNavigationBySession(values => Object.fromEntries(Object.entries(values).filter(([id]) => cachedSessions.includes(id))));
    resolvedSelection.current = Object.fromEntries(Object.entries(resolvedSelection.current).filter(([id]) => cachedSessions.includes(id)));
  }, [cachedSessions]);
  return <div className="dv-panel dv-theme" data-base={appearance.base}>
    <nav className="dv-panel-nav" aria-label="Diff view 功能"><div className="dv-panel-modes" role="group" aria-label="功能切换"><button onClick={() => setMode('session')} aria-pressed={mode === 'session'}>会话修改</button><button onClick={() => setMode('git')} aria-pressed={mode === 'git'}>本地 Git</button></div>{mode === 'git' && roots.length > 1 && <select aria-label="Git 项目" title={gitRoot} value={gitRoot} onChange={e => setGitRoot(e.target.value)}>{roots.map(root => <option key={root}>{root}</option>)}</select>}</nav>
    <div className="dv-panel-content">
    <div className="dv-panel-page" hidden={mode !== 'git'}>
      {gitError && <p className="dv-panel-message" role="alert">{gitError}</p>}
      {gitLoaded ? <GitManagement key={gitRoot} active={mode === 'git'} transport={transport} root={gitRoot || undefined} base={appearance.base} /> : mode === 'git' && <p className="dv-panel-message" role="status">正在读取 Git 项目…</p>}
    </div>
    <div className="dv-panel-page" hidden={mode !== 'session'}>
      {surfaceError && <p className="dv-panel-message" role="alert">{surfaceError}</p>}
      {error && sessionId && (showReview || cachedSessions.includes(sessionId)) && <div className="dv-panel-message" role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>重试</button><button onClick={() => { setFallback(true); setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(''); setSelecting(false); }}>返回本会话修改记录</button></div>}
      {cachedSessions.map(id => <div className="dv-panel-page" key={id} hidden={mode !== 'session' || sessionId !== id}>
        <ReviewApp active={mode === 'session' && sessionId === id} transport={transport} initialRequest={navigationBySession[id]?.request ?? { scope: 'lastTurn', sessionId: id }} initialFileId={navigationBySession[id]?.fileId} navigationKey={navigationBySession[id] ? `${navigationBySession[id].nonce}:${navigationBySession[id].revision}` : `session:${id}`} {...appearance} />
      </div>)}
      {!showReview && !cachedSessions.includes(sessionId) ? selecting || error ? <section className="dv-panel-message" role={error ? 'alert' : 'status'}>{error || '正在定位所选文件…'}{error && <><button onClick={() => { setFallback(false); setRetry(n => n + 1); }}>重试</button>{sessionId && <button onClick={() => { setFallback(true); setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(''); setSelecting(false); }}>返回本会话修改记录</button>}</>}</section> : !sessionId ? <section className="dv-panel-message" role="status">缺少会话身份，请从当前会话侧栏打开。历史记录不会回退到全局；本地 Git 可独立使用。</section> : null : null}
    </div>
    </div>
  </div>;
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<Panel />);
