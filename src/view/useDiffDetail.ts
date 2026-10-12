import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewDetail, UiTransport } from '../core/contracts';

/** Join bounded pages, including a hunk that continues across a page boundary. */
export function appendDiffPage(previous: ReviewDetail, page: ReviewDetail): ReviewDetail {
  if (page.file.id !== previous.file.id || page.file.fingerprint !== previous.file.fingerprint || page.offset !== previous.nextOffset || page.totalRows !== previous.totalRows) throw new Error('差异已变化，请刷新 / Diff changed; refresh the review');
  const hunks = previous.hunks.map(hunk => ({ ...hunk, lines: [...hunk.lines] }));
  for (const hunk of page.hunks) {
    const last = hunks.at(-1);
    if (last?.id === hunk.id) last.lines.push(...hunk.lines);
    else hunks.push({ ...hunk, lines: [...hunk.lines] });
  }
  return { ...page, offset: 0, hunks };
}

interface Cache { details: Map<string, ReviewDetail>; pending: Map<string, Promise<ReviewDetail>>; }
const caches = new WeakMap<UiTransport, Cache>();
function cacheFor(transport: UiTransport): Cache {
  let cache = caches.get(transport);
  if (!cache) { cache = { details: new Map(), pending: new Map() }; caches.set(transport, cache); }
  return cache;
}
function firstPage(transport: UiTransport, key: string, reviewId: string, fileId: string, context: number): Promise<ReviewDetail> {
  const cache = cacheFor(transport), existing = cache.pending.get(key);
  if (existing) return existing;
  const promise = transport.invoke<ReviewDetail>('file', { reviewId, fileId, offset: 0, limit: 80, context }).then(page => {
    if (page.file.id !== fileId || page.offset !== 0 || (page.nextOffset != null && page.nextOffset <= 0)) throw new Error('Invalid diff page');
    cache.details.set(key, page);
    while (cache.details.size > 100) cache.details.delete(cache.details.keys().next().value!);
    return page;
  }).finally(() => cache.pending.delete(key));
  cache.pending.set(key, promise); return promise;
}
export function prefetchDiffDetail(transport: UiTransport, reviewId: string | undefined, fileId: string, context = 3, reload = 0): void {
  if (!reviewId || !fileId) return;
  const key = `${reviewId}|${fileId}|${context}|${reload}`;
  const cache = cacheFor(transport);
  if (cache.details.has(key) || cache.pending.size > 0) return;
  void firstPage(transport, key, reviewId, fileId, context).catch(() => {});
}

export function useDiffDetail(transport: UiTransport, reviewId: string | undefined, fileId: string, context: number, reload: number, identity = reviewId ?? '', version?: string) {
  // New files change the review ID, not the existing file's content. Share verified pages by version.
  const key = `${version && reviewId ? `${identity}|${version}` : reviewId}|${fileId}|${context}|${reload}`;
  const requestKey = `${reviewId}|${fileId}|${context}|${reload}`;
  const detailCache = cacheFor(transport).details;
  const getInitialState = () => {
    const cached = reviewId && fileId ? detailCache.get(key) ?? detailCache.get(requestKey) : undefined;
    if (cached) return { detail: cached, loading: false, loadingMore: false, error: '' };
    return { detail: null, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' };
  };

  const [state, setState] = useState<{ detail: ReviewDetail | null; loading: boolean; loadingMore: boolean; error: string }>(getInitialState);
  const liveKey = useRef(key);
  liveKey.current = key;
  const renderedKey = useRef(key);
  const retained = useRef<{ transport: UiTransport; identity: string; fileId: string; context: number; reload: number; detail: ReviewDetail }>();
  const prior = retained.current;
  const previousDetail = reviewId && prior?.transport === transport && prior.identity === identity && prior.fileId === fileId && prior.context === context && prior.reload === reload ? prior.detail : null;
  const previousRef = useRef(previousDetail); previousRef.current = previousDetail;
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true, pending = false;
    let detail: ReviewDetail | null = (reviewId && fileId ? detailCache.get(key) ?? detailCache.get(requestKey) : null) ?? null;
    renderedKey.current = key;

    if (detail) {
      setState({ detail, loading: false, loadingMore: false, error: '' });
    } else {
      setState({ detail: previousRef.current, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' });
    }

    const load = async () => {
      if (!active || liveKey.current !== key || pending || !reviewId || !fileId || (detail && detail.nextOffset == null)) return;
      pending = true;
      const offset = detail?.nextOffset ?? 0;
      setState({ detail: detail ?? previousRef.current, loading: !detail, loadingMore: Boolean(detail), error: '' });
      try {
        const page = offset === 0 ? await firstPage(transport, requestKey, reviewId, fileId, context) : await transport.invoke<ReviewDetail>('file', { reviewId, fileId, offset, limit: 80, context });
        if (!active || liveKey.current !== key) return;
        if (page.file.id !== fileId || page.offset !== offset || (page.nextOffset != null && page.nextOffset <= offset)) throw new Error('无效的差异分页 / Invalid diff page');
        detail = detail ? appendDiffPage(detail, page) : page;
        detailCache.set(key, detail);
        while (detailCache.size > 100) detailCache.delete(detailCache.keys().next().value!);
        setState({ detail, loading: false, loadingMore: false, error: '' });
      } catch (error) {
        if (active && liveKey.current === key) setState({ detail: detail ?? previousRef.current, loading: false, loadingMore: false, error: error instanceof Error ? error.message : String(error) });
      } finally { pending = false; }
    };
    loadRef.current = load;
    if (!detail) void load();
    return () => { active = false; loadRef.current = null; };
  }, [transport, key, identity, reviewId]);

  const loadMore = useCallback(() => { void loadRef.current?.(); }, []);
  const currentCached = reviewId && fileId ? detailCache.get(key) ?? detailCache.get(requestKey) : undefined;
  const effectiveState = renderedKey.current === key ? state : (currentCached ? { detail: currentCached, loading: false, loadingMore: false, error: '' } : { detail: previousDetail, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' });
  if (effectiveState.detail && reviewId) retained.current = { transport, identity, fileId, context, reload, detail: effectiveState.detail };
  return { ...effectiveState, loadMore };
}
