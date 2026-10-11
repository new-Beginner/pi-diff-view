import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from './ReviewApp';
import type { ReviewRequest, UiTransport } from '../core/contracts';
import type { ReviewNavigation } from '../core/review-navigation';
interface Appearance { locale?: string; base?: 'light' | 'dark' }
interface Bridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; on?(event: string, callback: (data: any) => void): (() => void) | void }
declare global { interface Window { pluginBridge?: Bridge } }
export function Panel() {
  const [appearance, setAppearance] = useState<Appearance>({});
  const [navigation, setNavigation] = useState<ReviewNavigation | null>(null), [error, setError] = useState(''), [selecting, setSelecting] = useState(Boolean(new URLSearchParams(location.search).get('piViewOpen')));
  const hasSelection = useRef(false);
  const transport = useMemo<UiTransport>(() => ({ invoke<T>(method: string, args?: unknown) {
    const bridge = window.pluginBridge;
    if (!bridge) return Promise.reject(new Error('PI-Desktop bridge is unavailable / PI-Desktop 桥接不可用。'));
    return bridge.invoke<T>(`diff.${method}`, args);
  } }), []);
  useEffect(() => {
    let live = true;
    const update = (value: Appearance) => { if (!live) return; const valid = { locale: value?.locale, base: value?.base === 'light' || value?.base === 'dark' ? value.base : undefined }; setAppearance(valid); if (valid.locale) document.documentElement.lang = valid.locale; if (valid.base) document.documentElement.dataset.base = valid.base; };
    const dispose = window.pluginBridge?.on?.('appearance:changed', update);
    window.pluginBridge?.invoke<Appearance>('app.getAppearance').then(update).catch(() => undefined);
    return () => { live = false; if (typeof dispose === 'function') dispose(); };
  }, []);
  useEffect(() => {
    let live = true, generation = 0, target: string | null = null, pending = false;
    const load = () => {
      if (!target || pending) return;
      pending = true;
      const own = generation, nonce = target;
      transport.invoke<ReviewNavigation>('readTurnSelection', { nonce }).then(selection => {
        if (!live || own !== generation) return;
        hasSelection.current = true;
        setNavigation(previous => previous?.nonce === selection.nonce && previous.revision === selection.revision ? previous : selection);
        setError(''); setSelecting(false);
      }).catch(err => { if (live && own === generation) { hasSelection.current = false; setNavigation(null); setError(String(err?.message ?? err)); setSelecting(false); } }).finally(() => { pending = false; });
    };
    const receive = (path: unknown) => {
      if (path == null || path === '') return;
      generation++;
      if (typeof path !== 'string' || !/^diff-view:[0-9a-f-]{36}$/i.test(path)) { target = null; hasSelection.current = false; setNavigation(null); setSelecting(false); setError('无效的插件定位令牌 / Invalid plugin selection'); return; }
      target = path.slice('diff-view:'.length);
      if (!hasSelection.current) { setSelecting(true); setError(''); }
      load();
    };
    const dispose = window.pluginBridge?.on?.('view:open', value => receive(value?.path));
    receive(new URLSearchParams(location.search).get('piViewOpen'));
    // Read only volatile UI state. Never change the native view URL to select another file.
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, 500);
    return () => { live = false; generation++; clearInterval(timer); if (typeof dispose === 'function') dispose(); };
  }, [transport]);
  const initialRequest = useMemo<Partial<ReviewRequest>>(() => {
    const params = new URLSearchParams(location.search); const result: Partial<ReviewRequest> = {};
    for (const key of ['root', 'sessionId', 'runId', 'ref'] as const) if (params.get(key)) result[key] = params.get(key)!;
    const scope = params.get('scope'); if (scope && ['unstaged', 'staged', 'commit', 'branch', 'lastTurn', 'turn'].includes(scope)) result.scope = scope as ReviewRequest['scope'];
    return result;
  }, []);
  if (selecting || error) return <section className="dv-app" data-base={appearance.base ?? 'light'}><p className={`dv-empty ${error ? 'dv-error' : ''}`} role={error ? 'alert' : 'status'}>{error || '正在定位所选文件… / Locating selected file…'}</p></section>;
  return <ReviewApp transport={transport} initialRequest={navigation?.request ?? initialRequest} initialFileId={navigation?.fileId} navigationKey={navigation ? `${navigation.nonce}:${navigation.revision}` : undefined} {...appearance} />;
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<Panel />);
