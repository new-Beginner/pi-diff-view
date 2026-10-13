import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiTransport } from '../core/contracts';
import type { PluginReviewAdapter } from './plugin-review-adapter';
import { createRunningChangesController, type RunningView } from './running-changes';
import type { RendererLayer, RendererUi } from './host-contract';
import { openFloatingLayer } from './floating-layer';
const anchors = new Set<HTMLElement>();
interface Position { left: number; top: number; width: number; visible: boolean }
const hidden: Position = { left: 0, top: 0, width: 0, visible: false };
export default function RunningChangePill({ transport, adapter, ui, report }: { transport: UiTransport; adapter: PluginReviewAdapter; ui: RendererUi; report(stage: string): void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const controller = useRef<ReturnType<typeof createRunningChangesController>>();
  const [view, setView] = useState<RunningView>({ summary: null, busy: false, error: '' });
  const [position, setPosition] = useState<Position>(hidden);
  const [layer, setLayer] = useState<RendererLayer | null>(null);
  const [layerError, setLayerError] = useState('');
  useEffect(() => {
    let live = true, unsubscribe: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    const current = createRunningChangesController(transport, adapter, next => { if (live) setView(next); }, report); controller.current = current;
    report('composer-mounted');
    const subscribe = () => void adapter.subscribeActivity(activity => { if (live) current.setActivity(activity); }, report).then(dispose => { if (live) unsubscribe = dispose; else dispose(); }).catch(() => {
      if (live) { current.setActivity(null); report('composer-source-error'); retry = setTimeout(subscribe, 2000); }
    });
    subscribe();
    return () => { live = false; if (retry) clearTimeout(retry); current.dispose(); unsubscribe?.(); controller.current = undefined; };
  }, [transport, adapter, report]);
  useLayoutEffect(() => {
    const owner = anchor.current;
    if (!view.summary || !owner) { setPosition(hidden); return; }
    anchors.add(owner);
    let frame = 0, lastStage = '';
    const rectOf = (node: HTMLElement) => {
      const shell = node.closest<HTMLElement>('.composer-shell'), rect = shell?.getBoundingClientRect();
      return shell?.isConnected && shell.getClientRects().length && rect && rect.width > 80 && rect.top > 48 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth ? rect : null;
    };
    const update = () => {
      // Only the public slot's owning composer is measured. No host DOM is reparented or edited.
      const shell = owner.closest<HTMLElement>('.composer-shell'), rect = rectOf(owner);
      const first = [...anchors].find(node => rectOf(node));
      const visible = Boolean(rect && first === owner);
      const stage = !shell ? 'composer-anchor-missing' : !rect ? 'composer-anchor-offscreen' : 'composer-positioned';
      if (stage !== lastStage) { lastStage = stage; report(stage); }
      const next = visible && rect ? { left: rect.left + rect.width / 2, top: rect.top - 8, width: Math.min(rect.width - 16, window.innerWidth - 24), visible } : hidden;
      setPosition(previous => previous.visible === next.visible && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next);
      frame = requestAnimationFrame(update);
    };
    update(); return () => { cancelAnimationFrame(frame); anchors.delete(owner); };
  }, [view.summary?.runId, report]);
  const visible = !!view.summary && position.visible;
  useLayoutEffect(() => {
    setLayer(null); setLayerError('');
    if (!visible) return;
    let current: RendererLayer;
    try { current = openFloatingLayer(ui, document); }
    catch (error) {
      setLayerError(error instanceof Error ? error.message : String(error));
      report('composer-layer-error');
      return;
    }
    setLayer(current);
    return () => current.close();
  }, [visible, ui, report]);
  const summary = view.summary, zh = summary?.locale.startsWith('zh');
  const unknown = summary?.unknownFileCount ?? 0, allUnknown = !!summary && unknown >= summary.fileCount;
  return <><span ref={anchor} className="dv-running-anchor" aria-hidden="true" />{layerError && <span className="dv-running-error" role="alert">{layerError}</span>}{summary && visible && layer && createPortal(<div className="dv-running-float" data-base={summary.base} style={{ left: position.left, top: position.top, maxWidth: position.width }}>
    <button type="button" className="dv-running-pill" disabled={view.busy} aria-busy={view.busy} title={zh ? '查看本轮已捕获变更；仅统计可验证文本' : 'Review captured changes in this task; verified text counts only'} onClick={() => void controller.current?.open()}>
      <span className="dv-running-label">{zh ? `${summary.fileCount} 个文件已更改` : `${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'} changed`}</span>{!allUnknown && <><span className="dv-running-add">+{summary.additions}</span><span className="dv-running-del">-{summary.deletions}</span></>}{unknown > 0 && <span className="dv-running-unknown">{zh ? allUnknown ? '行数未知' : '部分统计' : allUnknown ? 'Unknown lines' : 'Partial totals'}</span>}
    </button>{view.error && <p className="dv-running-error" role="alert">{view.error}</p>}
  </div>, layer.element)}</>;
}
export const runningPillStyle = `
.dv-running-anchor{display:none!important}
.dv-running-float{position:fixed;z-index:20;transform:translate(-50%,-100%);font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;--rp-add:var(--ds-success,#008f39);--rp-del:var(--ds-error,#d63232);--rp-bg:var(--ds-bg-elevated-opaque,#fff);--rp-ink:var(--ds-text-secondary,#7c7c7c);--rp-border:var(--ds-border-subtle,#ececec)}
.dv-running-float[data-base=dark]{--rp-add:var(--ds-success,#40c977);--rp-del:var(--ds-error,#ff6764);--rp-bg:var(--ds-bg-elevated-opaque,#252525);--rp-ink:var(--ds-text-secondary,#b5b5b5);--rp-border:var(--ds-border-subtle,#3a3a3a)}
.dv-running-pill{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:5px;max-width:100%;min-height:34px;padding:7px 12px;border:1px solid var(--rp-border);border-radius:14px;background:var(--rp-bg);color:var(--rp-ink);font:inherit;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:0 2px 10px rgb(0 0 0 / .025)}
.dv-running-label{overflow:hidden;text-overflow:ellipsis;min-width:0}.dv-running-add,.dv-running-del,.dv-running-unknown{flex:none;font-size:12px}.dv-running-add{color:var(--rp-add)}.dv-running-del{color:var(--rp-del)}
.dv-running-pill:hover:not(:disabled){border-color:color-mix(in srgb,var(--rp-ink) 30%,var(--rp-border))}.dv-running-pill:focus-visible{outline:2px solid var(--ds-focus,#4384f5);outline-offset:3px}.dv-running-pill:disabled{cursor:wait;opacity:.65}
.dv-running-error{margin:5px 0 0;padding:6px 10px;border:1px solid var(--rp-border);border-radius:8px;background:var(--rp-bg);color:var(--rp-del);font-size:12px;overflow-wrap:anywhere;white-space:normal}
@media(max-width:420px){.dv-running-pill{font-size:13px;padding:7px 10px}}
`;