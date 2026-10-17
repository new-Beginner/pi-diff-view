import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DiffHunk, ReviewFile, ReviewSummary, UiTransport } from '../core/contracts';
import { DiffRows } from './DiffRows';
import { messages } from './i18n';
import { reconcileHunkViews, reviewFileVersion, type HunkView } from './live-diff';
import { useDiffDetail } from './useDiffDetail';

/** Additional files opened by the toolbar share the normal bounded detail cache.
 * Defer their reads until near the viewport, instead of flooding the bridge on expand-all. */
export default function ReviewFilePreview({ transport, review, file, context, reload, identity, layout, wrap, locale, viewport, actions }: {
  transport: UiTransport; review: ReviewSummary; file: ReviewFile; context: number; reload: number; identity: string;
  layout: 'unified' | 'split'; wrap: boolean; locale: string; viewport: RefObject<HTMLDivElement>;
  actions: (file: ReviewFile, hunk: DiffHunk, loading: boolean) => ReactNode;
}) {
  const t = messages(locale), pane = useRef<HTMLElement>(null), continuation = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false), [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (active || !pane.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setActive(true); observer.disconnect(); }
    }, { root: viewport.current, rootMargin: '120px 0px' });
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, [active, viewport]);
  const { detail, loading, loadingMore, error, loadMore } = useDiffDetail(transport, active ? review.id : undefined, file.id, context, reload + retry, identity, reviewFileVersion(file));
  const state = useRef<{ identity: string; views: HunkView[]; serial: number }>({ identity: '', views: [], serial: 0 });
  const hunkIdentity = `${identity}|${file.id}|${context}`;
  const views = useMemo(() => {
    const value = state.current;
    const views = reconcileHunkViews(value.identity === hunkIdentity ? value.views : [], detail?.hunks ?? [], () => `extra-hunk-${file.id}-${value.serial++}`);
    value.identity = hunkIdentity; value.views = views; return views;
  }, [detail?.hunks, hunkIdentity]);
  useEffect(() => {
    if (!continuation.current || detail?.nextOffset == null || loading || loadingMore || error || views.every(view => collapsed.has(view.key))) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { root: viewport.current, rootMargin: '120px 0px' });
    observer.observe(continuation.current);
    return () => observer.disconnect();
  }, [detail, loading, loadingMore, error, views, collapsed, loadMore, viewport]);
  return <section className="dv-review" ref={pane} aria-busy={loading || !active}>
    <h2 className="dv-sr-only">{file.path}</h2>
    <div className={`dv-diff-pane ${wrap ? 'dv-wrap' : 'dv-nowrap'}`} tabIndex={0} aria-label={`${file.path} ${t.title}`}>
      {(!active || loading) && !detail ? <div className="dv-empty" role="status">{t.loading}</div> : error && !detail ? <div className="dv-empty dv-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>{t.retry}</button></div> : file.kind !== 'text' && !file.segmentCount ? <div className="dv-empty">{t[file.kind]}</div> : detail && !detail.hunks.length ? <div className="dv-empty">{file.status === 'mode' ? t.mode : t.noHunks}</div> : views.map(({ key, hunk }) => <section className="dv-hunk" key={key}>
        <div className="dv-hunk-heading"><button data-hunk-nav aria-expanded={!collapsed.has(key)} onClick={() => setCollapsed(value => { const next = new Set(value); next.has(key) ? next.delete(key) : next.add(key); return next; })} aria-label={`${collapsed.has(key) ? t.collapsed : t.expanded} ${hunk.header}`}><span aria-hidden="true">{collapsed.has(key) ? '▸' : '▾'}</span> <code>{hunk.header}</code></button><div className="dv-toolbar">{context === 3 && !file.oldPath && review.scope !== 'turn' && review.scope !== 'lastTurn' && actions(detail?.file ?? file, hunk, loading)}</div></div>
        {!collapsed.has(key) && <DiffRows path={file.path} lines={hunk.lines} layout={layout} t={t} />}
      </section>)}
    </div>
    {detail?.nextOffset != null && <div className="dv-continuation" ref={continuation} aria-label={t.loadMore}>{loadingMore && <span role="status">{t.loading}</span>}{error && <span className="dv-error" role="alert">{error}<button onClick={loadMore}>{t.retry}</button></span>}</div>}
  </section>;
}
