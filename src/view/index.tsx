import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from './ReviewApp';
import { GitManagement } from './GitManagement';
import { ensureBounded } from './transport';
import type { Bootstrap, ReviewRequest, UiTransport } from '../core/contracts';
import type { ReviewNavigation } from '../core/review-navigation';
import './theme.css';
interface Appearance { locale?: string; base?: 'light' | 'dark' }
interface Bridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; on?(event: string, callback: (data: any) => void): (() => void) | void }
declare global { interface Window { pluginBridge?: Bridge } }
export function Panel() {
  const [appearance, setAppearance] = useState<Appearance>(() => ({ base: document.documentElement.dataset.base === 'dark' || (!document.documentElement.dataset.base && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light' }));
  const [route, setRoute] = useState<unknown>(() => new URLSearchParams(location.search).get('piViewOpen'));
  const [navigation, setNavigation] = useState<ReviewNavigation | null>(null);
  const [error, setError] = useState(''), [selecting, setSelecting] = useState(Boolean(route));
  const [retry, setRetry] = useState(0), [fallback, setFallback] = useState(false);
  const [mode, setMode] = useState<'session' | 'git'>('session');
  const [roots, setRoots] = useState<string[]>([]), [gitRoot, setGitRoot] = useState(''), [gitError, setGitError] = useState('');
  const [gitLoaded, setGitLoaded] = useState(false);
  const readySession = useRef('');
  const transport = useMemo<UiTransport>(() => ensureBounded({ invoke<T>(method: string, args?: unknown) {
    if (!window.pluginBridge) return Promise.reject(new Error('PI-Desktop 桥接不可用。'));
    return window.pluginBridge.invoke<T>(`diff.${method}`, args);
  } }), []);
  const [target, query = ''] = typeof route === 'string' ? route.split('?') : ['', ''];
  const sessionId = new URLSearchParams(query).get('sessionId') ?? new URLSearchParams(location.search).get('sessionId') ?? '';
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
    if (fallback || route == null || route === '') return;
    if (typeof route !== 'string') { setError('无效的视图定位参数'); return; }
    if (!sessionId) { setError('旧版视图没有会话标识，请从当前会话重新打开差异审查。'); return; }
    if (target === `diff-session:${encodeURIComponent(sessionId)}`) { setNavigation(null); return; }
    if (!/^diff-view:[0-9a-f-]{36}$/i.test(target)) { setError('无效的文件选择'); return; }
    if (mode !== 'session') return;
    const load = async () => {
      if (pending || !live) return;
      pending = true;
      try {
        const selected = await transport.invoke<ReviewNavigation>('readTurnSelection', { nonce: target.slice('diff-view:'.length), sessionId });
        if (!live) return;
        if (selected.sessionId !== sessionId || selected.request.sessionId !== sessionId) throw new Error('所选记录不属于当前会话。');
        setNavigation(previous => previous?.nonce === selected.nonce && previous.revision === selected.revision ? previous : selected);
        setError('');
      } catch (err) { if (live) { setNavigation(null); setError(String((err as Error)?.message ?? err)); } }
      finally { pending = false; if (live) setSelecting(false); }
    };
    setSelecting(true); void load();
    const timer = setInterval(() => { if (mode === 'session' && document.visibilityState !== 'hidden') void load(); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [transport, route, target, sessionId, retry, fallback, mode]);
  const initialRequest = useMemo<Partial<ReviewRequest>>(() => ({ scope: 'lastTurn', sessionId: sessionId || undefined }), [sessionId]);
  const activeNavigation = navigation?.sessionId === sessionId ? navigation : null;
  if (sessionId && !selecting && !error) readySession.current = sessionId;
  const showReview = Boolean(sessionId && !error && (!selecting || readySession.current === sessionId));
  return <div className="dv-panel dv-theme" data-base={appearance.base}>
    <nav className="dv-panel-nav" aria-label="Diff view 功能"><div className="dv-panel-modes" role="group" aria-label="功能切换"><button onClick={() => setMode('session')} aria-pressed={mode === 'session'}>会话修改</button><button onClick={() => setMode('git')} aria-pressed={mode === 'git'}>本地 Git</button></div>{mode === 'git' && roots.length > 1 && <select aria-label="Git 项目" title={gitRoot} value={gitRoot} onChange={e => setGitRoot(e.target.value)}>{roots.map(root => <option key={root}>{root}</option>)}</select>}</nav>
    <div className="dv-panel-content">
    <div className="dv-panel-page" hidden={mode !== 'git'}>
      {gitError && <p className="dv-panel-message" role="alert">{gitError}</p>}
      {gitLoaded ? <GitManagement key={gitRoot} active={mode === 'git'} transport={transport} root={gitRoot || undefined} base={appearance.base} /> : mode === 'git' && <p className="dv-panel-message" role="status">正在读取 Git 项目…</p>}
    </div>
    <div className="dv-panel-page" hidden={mode !== 'session'}>
      {showReview ? <ReviewApp key={sessionId} active={mode === 'session'} transport={transport} initialRequest={activeNavigation?.request ?? initialRequest} initialFileId={activeNavigation?.fileId} navigationKey={activeNavigation ? `${activeNavigation.nonce}:${activeNavigation.revision}` : `session:${sessionId}`} {...appearance} /> : selecting || error ?
        <section className="dv-panel-message" role={error ? 'alert' : 'status'}>{error || '正在定位所选文件…'}{error && <><button onClick={() => { setFallback(false); setRetry(n => n + 1); }}>重试</button>{sessionId && <button onClick={() => { setFallback(true); setNavigation(null); setError(''); setSelecting(false); }}>返回本会话修改记录</button>}</>}</section> :
        <section className="dv-panel-message" role="status">缺少会话身份，请从当前会话侧栏打开。历史记录不会回退到全局；本地 Git 可独立使用。</section>}
    </div>
    </div>
  </div>;
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<Panel />);
