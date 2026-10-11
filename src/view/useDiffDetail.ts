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

const detailCache = new Map<string, ReviewDetail>();
const pendingPrefetches = new Map<string, Promise<unknown>>();

export function prefetchDiffDetail(transport: UiTransport, reviewId: string | undefined, fileId: string, context = 3, reload = 0): void {
  if (!reviewId || !fileId) return;
  const key = `${reviewId}|${fileId}|${context}|${reload}`;
  if (detailCache.has(key) || pendingPrefetches.has(key)) return;
  const promise = transport.invoke<ReviewDetail>('file', { reviewId, fileId, offset: 0, limit: 80, context })
    .then(page => {
      detailCache.set(key, page);
      while (detailCache.size > 100) detailCache.delete(detailCache.keys().next().value!);
    })
    .catch(() => {})
    .finally(() => { pendingPrefetches.delete(key); });
  pendingPrefetches.set(key, promise);
}

export function useDiffDetail(transport: UiTransport, reviewId: string | undefined, fileId: string, context: number, reload: number) {
  const key = `${reviewId}|${fileId}|${context}|${reload}`;
  const getInitialState = () => {
    const cached = reviewId && fileId ? detailCache.get(key) : undefined;
    if (cached) return { detail: cached, loading: false, loadingMore: false, error: '' };
    return { detail: null, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' };
  };

  const [state, setState] = useState<{ detail: ReviewDetail | null; loading: boolean; loadingMore: boolean; error: string }>(getInitialState);
  const liveKey = useRef(key);
  liveKey.current = key;
  const renderedKey = useRef(key);
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true, pending = false;
    let detail: ReviewDetail | null = (reviewId && fileId ? detailCache.get(key) : null) ?? null;
    renderedKey.current = key;

    if (detail) {
      setState({ detail, loading: false, loadingMore: false, error: '' });
    } else {
      setState({ detail: null, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' });
    }

    const load = async () => {
      if (!active || liveKey.current !== key || pending || !reviewId || !fileId || (detail && detail.nextOffset == null)) return;
      pending = true;
      const offset = detail?.nextOffset ?? 0;
      setState({ detail, loading: !detail, loadingMore: Boolean(detail), error: '' });
      try {
        const page = await transport.invoke<ReviewDetail>('file', { reviewId, fileId, offset, limit: 80, context });
        if (!active || liveKey.current !== key) return;
        if (page.file.id !== fileId || page.offset !== offset || (page.nextOffset != null && page.nextOffset <= offset)) throw new Error('无效的差异分页 / Invalid diff page');
        detail = detail ? appendDiffPage(detail, page) : page;
        detailCache.set(key, detail);
        while (detailCache.size > 100) detailCache.delete(detailCache.keys().next().value!);
        setState({ detail, loading: false, loadingMore: false, error: '' });
      } catch (error) {
        if (active && liveKey.current === key) setState({ detail, loading: false, loadingMore: false, error: error instanceof Error ? error.message : String(error) });
      } finally { pending = false; }
    };
    loadRef.current = load;
    if (!detail) void load();
    return () => { active = false; loadRef.current = null; };
  }, [transport, key]);

  const loadMore = useCallback(() => { void loadRef.current?.(); }, []);
  const currentCached = reviewId && fileId ? detailCache.get(key) : undefined;
  const effectiveState = renderedKey.current === key ? state : (currentCached ? { detail: currentCached, loading: false, loadingMore: false, error: '' } : { detail: null, loading: Boolean(reviewId && fileId), loadingMore: false, error: '' });
  return { ...effectiveState, loadMore };
}
