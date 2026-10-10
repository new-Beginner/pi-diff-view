import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from './ReviewApp';
import type { ReviewRequest, UiTransport } from '../core/contracts';
interface Appearance { locale?: string; base?: 'light' | 'dark' }
interface Bridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; on?(event: string, callback: (data: Appearance) => void): (() => void) | void }
declare global { interface Window { pluginBridge?: Bridge } }
function Panel() {
  const [appearance, setAppearance] = useState<Appearance>({});
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
  const initialRequest = useMemo<Partial<ReviewRequest>>(() => {
    const params = new URLSearchParams(location.search); const result: Partial<ReviewRequest> = {};
    for (const key of ['root', 'sessionId', 'runId', 'ref'] as const) if (params.get(key)) result[key] = params.get(key)!;
    const scope = params.get('scope'); if (scope && ['unstaged', 'staged', 'commit', 'branch', 'lastTurn', 'turn'].includes(scope)) result.scope = scope as ReviewRequest['scope'];
    return result;
  }, []);
  return <ReviewApp transport={transport} initialRequest={initialRequest} {...appearance} />;
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<Panel />);
