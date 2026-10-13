import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Action, ActionResult, Bootstrap, DiffHunk, ReviewActionRequest, ReviewFile, ReviewFilesPage, ReviewRequest, ReviewSummary, Scope, UiTransport } from '../core/contracts';
import { isImagePath } from '../core/review-file-policy';
import { requiresSystemOpenConfirmation } from '../core/system-open-policy';
import { DiffRows } from './DiffRows';
import FilePath from './FilePath';
import FileIcon from './FileIcon';
import ReviewIcon from './ReviewIcon';
import { messages, kindLabel } from './i18n';
import { ensureBounded } from './transport';
import { useDiffDetail, prefetchDiffDetail, prepareDiffDetail } from './useDiffDetail';
import { captureScrollAnchor, restoreScrollAnchor, reconcileHunkViews, reviewFileVersion, type HunkView, type ScrollAnchor } from './live-diff';
import './review.css';

export interface ReviewAppProps { transport: UiTransport; initialRequest?: Partial<ReviewRequest>; initialFileId?: string; navigationKey?: string; active?: boolean; onClose?: () => void; locale?: string; base?: 'light' | 'dark' }
type Confirmation = { kind: 'action'; file: ReviewFile; action: Action; hunk?: DiffHunk; review: ReviewSummary } | { kind: 'batch'; files: ReviewFile[]; action: Action; review: ReviewSummary } | { kind: 'history' } | { kind: 'systemOpen'; file: ReviewFile; review: ReviewSummary; scope: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function Modal({ title, children, onClose, busy }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="dv-dialog" ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}
export function ReviewApp({ transport: source, initialRequest = {}, initialFileId, navigationKey, active: panelActive = true, onClose, locale: hostLocale, base: hostBase }: ReviewAppProps) {
  const transport = useMemo(() => ensureBounded(source), [source]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [bootTick, setBootTick] = useState(0);
  const [locale, setLocale] = useState(hostLocale ?? 'zh-CN');
  const [base, setBase] = useState<'light' | 'dark'>(hostBase ?? 'light');
  const t = messages(locale);
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const [wrap, setWrap] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fileCollapsed, setFileCollapsed] = useState(false);
  const appRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const closeMenus = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      appRef.current?.querySelectorAll<HTMLDetailsElement>('.dv-menu[open]').forEach(menu => {
        if (event instanceof KeyboardEvent || !menu.contains(event.target as Node)) menu.open = false;
      });
    };
    document.addEventListener('pointerdown', closeMenus); document.addEventListener('keydown', closeMenus);
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', closeMenus); };
  }, []);
  const [request, setRequest] = useState<ReviewRequest>({ scope: initialRequest.scope ?? (initialRequest.sessionId ? 'lastTurn' : 'unstaged'), ...initialRequest });
  // Only an explicit latest-mode filter may constrain the automatic session view.
  const latestRoot = useRef(initialRequest.scope === 'lastTurn' ? initialRequest.root : undefined);
  const [refDraft, setRefDraft] = useState(initialRequest.ref ?? '');
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [loadingReview, setLoadingReview] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [context, setContext] = useState(3);
  const [detailTick, setDetailTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openingFile, setOpeningFile] = useState(false);
  const fileOpenPending = useRef(false);
  const [openingSystemFile, setOpeningSystemFile] = useState(false);
  const systemOpenPending = useRef(false);
  const [status, setStatus] = useState('');
  const statusTimer = useRef<ReturnType<typeof setTimeout>>();
  const showStatus = (message: string) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(message);
    statusTimer.current = setTimeout(() => { statusTimer.current = undefined; setStatus(''); }, 3000);
  };
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);
  const [batchResults, setBatchResults] = useState<{ path: string; ok: boolean; message: string }[]>([]);
  useEffect(() => { if (!panelActive) setConfirmation(null); }, [panelActive]);
  const live = useRef(true);
  const sessionKey = initialRequest.sessionId ?? request.sessionId;
  const scopeKey = `${request.scope}|${request.root}|${request.ref}|${request.sessionId}|${request.runId}`;
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  useEffect(() => { setConfirmation(value => value?.kind === 'systemOpen' && value.scope !== scopeKey ? null : value); }, [scopeKey]);
  const diffPane = useRef<HTMLDivElement>(null);
  const reviewPending = useRef(false), loadedScope = useRef('');
  const historyRevision = useRef('');
  const workspaceRef = useRef<HTMLDivElement>(null), continuationRef = useRef<HTMLDivElement>(null);
  const fileCollapseAnchor = useRef<{ selected: string; top: number }>();
  useLayoutEffect(() => {
    const anchor = fileCollapseAnchor.current;
    fileCollapseAnchor.current = undefined;
    const viewport = workspaceRef.current, row = appRef.current?.querySelector<HTMLElement>('.dv-file[aria-current="true"]')?.closest<HTMLElement>('.dv-file-row');
    if (anchor && fileCollapsed && anchor.selected === selected && viewport && row) {
      // Removing a long body can clamp/anchor the browser to an unrelated trailing file.
      // Restore the current title's viewport position after the new file height is committed.
      viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.top;
    }
  }, [fileCollapsed, selected]);
  const matchingReview = review && review.scope === request.scope && (!request.root || review.root === request.root) && review.sessionId === request.sessionId && (request.scope !== 'turn' || review.runId === request.runId) ? review : null;
  const validReview = matchingReview?.files.some(file => file.id === selected) ? matchingReview : null;
  const selectedFile = matchingReview?.files.find(file => file.id === selected);
  const detailVersion = selectedFile ? reviewFileVersion(selectedFile) : undefined;
  const { detail, loading: loadingDetail, loadingMore, error: detailError, loadMore } = useDiffDetail(transport, validReview?.id, selected, context, detailTick, `${scopeKey}|${matchingReview?.runId ?? ''}`, detailVersion);
  const displayed = useRef({ selected, context, detailTick, detail, review: matchingReview });
  displayed.current = { selected, context, detailTick, detail, review: matchingReview };
  const scrollAnchor = useRef<ScrollAnchor>();
  useLayoutEffect(() => {
    if (scrollAnchor.current && workspaceRef.current) restoreScrollAnchor(workspaceRef.current, scrollAnchor.current);
    scrollAnchor.current = undefined;
  }, [review, detail]);
  const hunkState = useRef<{ identity: string; views: HunkView[]; serial: number }>({ identity: '', views: [], serial: 0 });
  const hunkIdentity = `${scopeKey}|${selected}|${context}`;
  const viewHunks = useMemo(() => {
    const state = hunkState.current;
    const previous = state.identity === hunkIdentity ? state.views : [];
    const views = reconcileHunkViews(previous, detail?.hunks ?? [], () => `hunk-view-${state.serial++}`);
    state.identity = hunkIdentity; state.views = views; return views;
  }, [detail?.hunks, hunkIdentity]);
  useEffect(() => {
    const target = continuationRef.current;
    if (!target || !detail || detail.nextOffset == null || loadingDetail || loadingMore || detailError || fileCollapsed || viewHunks.every(view => collapsed.has(view.key))) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { root: workspaceRef.current, rootMargin: '120px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [detail, loadingDetail, loadingMore, detailError, fileCollapsed, collapsed, viewHunks, loadMore]);
  useEffect(() => {
    if (detail && initialRequest.runId && (!initialFileId || selected === initialFileId)) void transport.invoke('rendererReport', { stage: 'view-targeted' }).catch(() => {});
  }, [transport, detail?.file.id, initialRequest.runId]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!validReview?.id || !review?.files.length) return;
    const reviewId = validReview.id;
    const index = review.files.findIndex(file => file.id === selected);
    const candidates = review.files.slice(index + 1, index + 3).filter(f => f.kind === 'text');
    const timer = setTimeout(() => {
      // At most one speculative request; clicks share the pending page instead of queuing duplicates.
      if (!loadingDetail && candidates[0]) prefetchDiffDetail(transport, reviewId, candidates[0].id, context, detailTick);
    }, 1000);
    return () => clearTimeout(timer);
  }, [transport, validReview?.id, review, selected, context, detailTick, loadingDetail]);
  useEffect(() => { if (hostLocale) setLocale(hostLocale); }, [hostLocale]);
  useEffect(() => { if (hostBase) setBase(hostBase); }, [hostBase]);
  const previousNavigation = useRef(navigationKey);
  useEffect(() => {
    if (!navigationKey) return;
    const changedNavigation = previousNavigation.current !== navigationKey;
    previousNavigation.current = navigationKey;
    const next: ReviewRequest = { ...initialRequest, scope: initialRequest.scope ?? 'turn' };
    const sameReview = review?.scope === next.scope && review?.root === next.root && review?.runId === next.runId && review?.sessionId === next.sessionId;
    const target = initialFileId ?? (sameReview ? review?.files[0]?.id : undefined) ?? '';
    setRequest(next); setSelected(target); setFileCollapsed(false); setQuery('');
    setCollapsed(new Set()); setConfirmation(null); setError('');
    // Only refresh the bounded file list when the target is outside it or a prior load is still pending.
    if ((sameReview && target && !review?.files.some(file => file.id === target)) || (changedNavigation && (!review || loadingReview))) setRefreshTick(value => value + 1);
  }, [navigationKey]);
  useEffect(() => {
    if (!panelActive || !navigationKey || !selected) return;
    appRef.current?.querySelector<HTMLElement>('.dv-file[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [navigationKey, selected]);
  useEffect(() => {
    let active = true; setBootError('');
    const load = () => transport.invoke<Bootstrap>('bootstrap', { sessionId: initialRequest.sessionId }).then(data => {
      if (!active) return;
      setBoot(data); setLayout(data.settings.layout); setWrap(data.settings.wordWrap);
      if (!hostLocale) setLocale(data.locale); if (!hostBase) setBase(data.base);
      if (bootTick > 0) setRefreshTick(value => value + 1);
      setRequest(previous => {
        if (previous.scope === 'lastTurn') return previous;
        if (previous.root) return previous;
        const run = data.runs.find(item => item.id === previous.runId) ?? data.runs.find(item => item.sessionId === previous.sessionId) ?? data.runs[0];
        const root = previous.scope === 'turn' ? run?.root : data.repositories[0]?.root;
        return { ...previous, root, ...(previous.scope === 'turn' && run ? { sessionId: previous.sessionId ?? run.sessionId, runId: previous.runId ?? run.id } : {}) };
      });
    }).catch(err => { if (active) setBootError(errorText(err)); });
    // An exact task/root is already known: paint its diff before loading optional history/settings.
    const timer = bootTick === 0 && initialRequest.runId && initialRequest.root ? setTimeout(load, 180) : undefined;
    if (!timer) void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [transport, bootTick, sessionKey]);
  useEffect(() => {
    if (!panelActive) return;
    if (!boot && !request.root && !request.sessionId && !request.runId) return;
    let active = true;
    const changedScope = loadedScope.current !== scopeKey;
    loadedScope.current = scopeKey;
    setReviewError('');
    if (changedScope) { setReview(null); setConfirmation(null); setCollapsed(new Set()); }
    if (!request.root && !request.sessionId && !request.runId) { setLoadingReview(false); return; }
    if ((request.scope === 'commit' || request.scope === 'branch') && !request.ref?.trim()) { setLoadingReview(false); setReviewError(t.emptyRef); return; }
    // Background updates never clear existing content or disable its read-only controls.
    reviewPending.current = true; setLoadingReview(changedScope || !matchingReview);
    transport.invoke<ReviewSummary>('review', { ...request, focusFileId: request.scope === 'turn' && request.runId === initialRequest.runId ? initialFileId : undefined }).then(async response => {
      if (!active) return;
      if (response.scope !== request.scope || response.sessionId !== request.sessionId || (request.scope === 'turn' && response.runId !== request.runId) || (request.root && response.root !== request.root)) throw new Error('审查结果与当前会话或轮次不匹配，请刷新。');
      if (review?.id === response.id && review.nextFileOffset == null) return;
      let data: ReviewSummary = { ...response, files: response.files.filter(file => !isImagePath(file.path)), nextFileOffset: response.nextFileOffset ?? null };
      const targetId = (id: string) => data.files.some(file => file.id === id) ? id : initialFileId && data.files.some(file => file.id === initialFileId) ? initialFileId : data.nextFileOffset != null ? initialFileId ?? id : data.files[0]?.id ?? '';
      const publish = async () => {
        if (matchingReview) {
          // Prepare the replacement before publishing its metadata. Nothing currently visible is cleared.
          while (active) {
            const current = displayed.current;
            const id = targetId(current.selected), nextFile = data.files.find(file => file.id === id);
            const previous = current.detail?.file.id === id ? current.detail : null;
            if (nextFile?.kind === 'text' && (!previous || current.review?.runId !== data.runId || reviewFileVersion(previous.file) !== reviewFileVersion(nextFile))) {
              await prepareDiffDetail(transport, data.id, id, current.context, current.detailTick, previous, () => !active);
            }
            if (!active) return;
            const latest = displayed.current;
            if (latest.selected !== current.selected || latest.context !== current.context || latest.detailTick !== current.detailTick || latest.detail !== current.detail) continue;
            if (workspaceRef.current) scrollAnchor.current = captureScrollAnchor(workspaceRef.current);
            break;
          }
        }
        if (!active) return;
        const id = targetId(displayed.current.selected);
        if (id !== displayed.current.selected) { setCollapsed(new Set()); setFileCollapsed(false); }
        setReview(data); setSelected(id);
        if (data.run) {
          const revision = `${data.run.id}:${data.run.state}`;
          if (historyRevision.current !== revision) {
            historyRevision.current = revision;
            const recorded = boot?.runs.find(run => run.id === data.runId);
            // Refresh once per task/state transition, not once per poll/page.
            if (boot && (!recorded || recorded.state !== data.run.state)) setBootTick(value => value + 1);
          }
        }
      };
      const streaming = !matchingReview;
      if (streaming || data.nextFileOffset == null) await publish();
      while (data.nextFileOffset != null && active) {
        const offset = data.nextFileOffset;
        const page = await transport.invoke<ReviewFilesPage>('reviewFiles', { reviewId: data.id, offset });
        if (!active) return;
        if (page.reviewId !== data.id || page.offset !== offset || (page.nextOffset != null && page.nextOffset <= offset)) throw new Error('无效的文件列表分页。');
        data = { ...data, files: [...data.files, ...page.files.filter(file => !isImagePath(file.path))], nextFileOffset: page.nextOffset };
        if (streaming || data.nextFileOffset == null) await publish();
      }
    }).catch(err => { if (active) setReviewError(errorText(err)); }).finally(() => { if (active) { reviewPending.current = false; setLoadingReview(false); } });
    return () => { active = false; reviewPending.current = false; };
  }, [transport, scopeKey, refreshTick, panelActive]);
  const resetPage = () => { setCollapsed(new Set()); };
  useEffect(() => {
    if (!panelActive || (request.scope !== 'lastTurn' && matchingReview?.run?.state !== 'running')) return;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden' && !reviewPending.current) setRefreshTick(value => value + 1); }, 750);
    return () => clearInterval(timer);
  }, [panelActive, request.scope, scopeKey, matchingReview?.runId, matchingReview?.run?.state]);
  const currentFile = detail?.file.id === selected ? detail.file : matchingReview?.files.find(file => file.id === selected);
  const visibleFiles = useMemo(() => {
    const needle = query.toLowerCase();
    return matchingReview?.files.filter(file => `${file.path} ${file.oldPath ?? ''}`.toLowerCase().includes(needle)) ?? [];
  }, [matchingReview?.files, query]);
  const sessionRuns = useMemo(() => {
    const runs = (boot?.runs ?? []).filter(run => !sessionKey || run.sessionId === sessionKey);
    if (matchingReview?.run && (!sessionKey || matchingReview.run.sessionId === sessionKey)) return [matchingReview.run, ...runs.filter(run => run.id !== matchingReview.runId)].sort((a, b) => b.startedAt - a.startedAt);
    return runs;
  }, [boot?.runs, matchingReview?.run, sessionKey]);
  const selectedRunId = request.scope === 'lastTurn' ? matchingReview?.runId ?? '' : request.runId ?? '';
  const verifiedFiles = useMemo(() => matchingReview?.files.filter(file => file.statsKnown !== false && file.kind === 'text') ?? [], [matchingReview?.files]);
  const unknownFiles = (matchingReview?.files.length ?? 0) - verifiedFiles.length;
  const roots = useMemo(() => [...new Set([...(boot?.repositories.map(repo => repo.root) ?? []), ...sessionRuns.map(run => run.root), ...(request.root ? [request.root] : [])])], [boot?.repositories, sessionRuns, request.root]);
  const perform = async (job: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setStatus('');
    try { await job(); } catch (err) { if (live.current) setError(errorText(err)); }
    finally { if (live.current) setBusy(false); }
  };
  const saveSettings = (next: { layout?: 'unified' | 'split'; wordWrap?: boolean }) => {
    if (next.layout) setLayout(next.layout); if (next.wordWrap != null) setWrap(next.wordWrap);
    transport.invoke('settings', next).catch(err => { if (live.current) setError(errorText(err)); });
  };
  const navigateHunk = useCallback((direction: number) => {
    const buttons = Array.from(diffPane.current?.querySelectorAll<HTMLButtonElement>('[data-hunk-nav]') ?? []);
    if (!buttons.length) return;
    const focused = buttons.findIndex(button => button === document.activeElement || button.closest('.dv-hunk')?.contains(document.activeElement));
    const next = focused < 0 ? direction > 0 ? 0 : buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, focused + direction));
    buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest' });
  }, []);
  const confirmOperation = () => perform(async () => {
    const target = confirmation; if (!target) return;
    const key = scopeRef.current;
    if (target.kind === 'action') {
      const args: ReviewActionRequest = { reviewId: target.review.id, fileId: target.file.id, action: target.action, hunkId: target.hunk?.id, fingerprint: target.file.fingerprint, confirmed: true };
      const result = await transport.invoke<ActionResult>('action', args);
      if (!live.current) return;
      setConfirmation(null);
      if (!result.ok) { setError(`${t.actionConflict} ${result.message}`); return; }
      showStatus(result.message || t.actionOk); if (scopeRef.current === key) setRefreshTick(value => value + 1);
    } else if (target.kind === 'batch') {
      const result = await transport.invoke<{ results: { path: string; ok: boolean; message: string }[] }>('batchAction', { reviewId: target.review.id, action: target.action, targets: target.files.map(file => ({ fileId: file.id, fingerprint: file.fingerprint })), confirmed: true });
      if (!live.current) return;
      setConfirmation(null); setBatchResults(result.results); if (scopeRef.current === key) setRefreshTick(value => value + 1);
    } else if (target.kind === 'history') {
      await transport.invoke('clearHistory', { confirmed: true });
      if (!live.current) return;
      setConfirmation(null); showStatus(t.cleared); setBootTick(value => value + 1);
    } else if (target.kind === 'systemOpen') {
      setConfirmation(null);
      if (target.scope === scopeRef.current && panelActive) await openWithDefaultApp(target.file, target.review);
    }
  });
  const copyPatch = (fileId = currentFile?.id) => perform(async () => {
    if (!matchingReview) return;
    await transport.invoke('copyPatch', { reviewId: matchingReview.id, fileId });
    if (live.current) showStatus(t.copied);
  });
  const copyPath = (file: ReviewFile) => perform(async () => {
    if (!matchingReview) return;
    await transport.invoke('copyPath', { reviewId: matchingReview.id, fileId: file.id });
    if (live.current) showStatus(locale.startsWith('zh') ? '路径已复制' : 'Path copied');
  });
  const openFile = (file: ReviewFile) => { resetPage(); setSelected(file.id); setFileCollapsed(false); };
  const collapseFile = () => {
    const viewport = workspaceRef.current, row = appRef.current?.querySelector<HTMLElement>('.dv-file[aria-current="true"]')?.closest<HTMLElement>('.dv-file-row');
    if (viewport && row) fileCollapseAnchor.current = { selected, top: Math.max(0, Math.min(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top, viewport.clientHeight - row.offsetHeight)) };
    setFileCollapsed(true);
  };
  const openInFileManager = async (file: ReviewFile) => {
    if (!matchingReview || fileOpenPending.current) return;
    fileOpenPending.current = true; setOpeningFile(true); setError('');
    const scope = scopeKey;
    try {
      const { requestId } = await transport.invoke<{ requestId: string }>('openFile', { reviewId: matchingReview.id, fileId: file.id, sessionId: matchingReview.sessionId });
      const deadline = Date.now() + 12000;
      while (live.current && scopeRef.current === scope) {
        const result = await transport.invoke<{ state: 'pending' | 'done' | 'error'; error?: string }>('openFile', { requestId, wait: true });
        if (result.state === 'done') return;
        if (result.state === 'error') throw new Error(result.error || t.error);
        if (Date.now() > deadline) throw new Error(locale.startsWith('zh') ? '文件管理器没有响应，请重试。' : 'File Manager did not respond. Please retry.');
      }
    } catch (err) { if (live.current && scopeRef.current === scope) setError(errorText(err)); }
    finally { fileOpenPending.current = false; if (live.current) setOpeningFile(false); }
  };
  const openWithDefaultApp = async (file: ReviewFile, targetReview = matchingReview) => {
    if (!targetReview?.sessionId || systemOpenPending.current || !panelActive) return;
    systemOpenPending.current = true; setOpeningSystemFile(true); setError(''); setStatus('');
    const scope = scopeKey;
    try {
      await transport.invoke('openSystemFile', { reviewId: targetReview.id, fileId: file.id, sessionId: targetReview.sessionId });
      if (live.current && scopeRef.current === scope) showStatus(locale.startsWith('zh') ? '已向系统提交打开请求' : 'Open request submitted to the system');
    } catch (err) { if (live.current && scopeRef.current === scope) setError(errorText(err)); }
    finally { systemOpenPending.current = false; if (live.current) setOpeningSystemFile(false); }
  };
  const requestSystemOpen = (file: ReviewFile) => {
    if (!matchingReview?.sessionId || systemOpenPending.current || busy) return;
    if (requiresSystemOpenConfirmation(file.absolutePath ?? file.path)) {
      setError(''); setConfirmation({ kind: 'systemOpen', file, review: matchingReview, scope: scopeKey });
    } else void openWithDefaultApp(file);
  };
  const closeFileMenu = (event: React.MouseEvent<HTMLButtonElement>) => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; };
  const placeFileMenu = (menu: HTMLDetailsElement) => {
    if (!menu.open) return;
    const body = menu.querySelector<HTMLElement>('.dv-menu-body'), bounds = workspaceRef.current?.getBoundingClientRect();
    if (!body || !bounds) return;
    const row = menu.getBoundingClientRect();
    const below = bounds.bottom - row.bottom - 5, above = row.top - bounds.top - 5;
    const upward = body.scrollHeight > below && above > below;
    menu.dataset.placement = upward ? 'above' : 'below';
    body.style.maxHeight = `${Math.max(60, upward ? above : below)}px`;
  };
  const actionButtons = (file: ReviewFile, hunk?: DiffHunk) => file.actions.map(action => <button key={action} disabled={busy || loadingReview || loadingDetail} onClick={() => { setError(''); if (review) setConfirmation({ kind: 'action', action, file, hunk, review }); }}>{t[action]}</button>);
  const selectedIndex = visibleFiles.findIndex(file => file.id === selected);
  const fileRow = (file: ReviewFile) => <div className="dv-file-row" key={file.id} data-expanded={file.id === selected && !fileCollapsed}>
    <button className="dv-file" aria-current={file.id === selected ? 'true' : undefined} aria-expanded={file.id === selected && !fileCollapsed} disabled={busy} onPointerEnter={() => { if (validReview?.id && file.kind === 'text') prefetchDiffDetail(transport, validReview.id, file.id, context, detailTick); }} onClick={() => { if (file.id === selected) { if (fileCollapsed) setFileCollapsed(false); else collapseFile(); } else openFile(file); }} title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.absolutePath ?? file.path} · ${t[file.status]}`}>
      <FileIcon path={file.path} /><span className="dv-file-label"><span className="dv-file-name"><FilePath path={file.path} /></span><span className="dv-file-chevron"><ReviewIcon name="chevron" /></span></span>{file.statsKnown === false || file.kind !== 'text' ? <span className="dv-counts dv-muted" aria-label={locale.startsWith('zh') ? '行数未知' : 'Unknown totals'}>{locale.startsWith('zh') ? '行数未知' : 'Unknown'}</span> : <span className="dv-counts"><span className="dv-added">+{file.additions}</span><span className="dv-deleted">-{file.deletions}</span></span>}
    </button>
    {file.id === selected && <button className="dv-icon-button dv-file-collapse" disabled={busy} aria-expanded={!fileCollapsed} aria-label={`${fileCollapsed ? locale.startsWith('zh') ? '展开文件' : 'Expand file' : locale.startsWith('zh') ? '折叠文件' : 'Collapse file'} ${file.path}`} title={fileCollapsed ? locale.startsWith('zh') ? '展开文件' : 'Expand file' : locale.startsWith('zh') ? '折叠文件' : 'Collapse file'} onClick={() => { if (fileCollapsed) setFileCollapsed(false); else collapseFile(); }}><ReviewIcon name={fileCollapsed ? 'chevron' : 'collapse'} /></button>}
    <button className="dv-icon-button dv-file-open" disabled={busy || openingFile} aria-label={`${locale.startsWith('zh') ? '打开文件' : 'Open file'} ${file.path}`} title={locale.startsWith('zh') ? '在 PI-Desktop 文件管理器中打开' : 'Open in PI-Desktop File Manager'} onClick={() => void openInFileManager(file)}><ReviewIcon name="open" /></button>
    <details className="dv-menu dv-file-menu" onToggle={event => placeFileMenu(event.currentTarget)}><summary aria-label={`${t.action} ${file.path}`} title={t.action}><ReviewIcon name="more" /></summary><div className="dv-menu-body">
      <button disabled={busy || !matchingReview} onClick={event => { closeFileMenu(event); void copyPath(file); }}>{locale.startsWith('zh') ? '复制路径' : 'Copy path'}</button>
      <button disabled={busy || openingSystemFile || !matchingReview?.sessionId} title={locale.startsWith('zh') ? '使用系统默认程序打开当前磁盘文件' : 'Open the current disk file with its default app'} onClick={event => { closeFileMenu(event); requestSystemOpen(file); }}>{locale.startsWith('zh') ? '外部打开' : 'Open with default app'}</button>
      <button disabled={busy} onClick={event => { closeFileMenu(event); openFile(file); }}>{locale.startsWith('zh') ? '展开文件' : 'Expand file'}</button>
      <button disabled={busy || !matchingReview || file.kind === 'unavailable'} onClick={() => void copyPatch(file.id)}>{t.copy}</button>
      {file.actions.length > 0 && <><hr />{actionButtons(file)}</>}
      {file.oldPath && <p>← {file.oldPath}</p>}<p className="dv-muted">{t[file.status]} · {kindLabel(file.kind, locale)}</p>{file.note && <p className="dv-muted">{file.note}</p>}
    </div></details>
  </div>;
  const runLabel = (id: string) => { const run = sessionRuns.find(item => item.id === id); return run ? `${new Date(run.startedAt).toLocaleString(locale)} · ${run.prompt?.slice(0, 60) ?? run.id} · ${t[run.state]}${run.incomplete ? ` · ${t.incomplete}` : ''}` : id; };
  return <section ref={appRef} className="dv-app" data-base={base} lang={locale} aria-label={t.title} onKeyDown={event => { if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !confirmation) { event.preventDefault(); navigateHunk(event.key === 'ArrowDown' ? 1 : -1); } }}>
    <header className="dv-top">
      <div className="dv-heading">
        <div className="dv-review-pill"><select className="dv-scope" aria-label={t.scope} value={request.scope} disabled={!boot || busy} onChange={event => {
          const scope = event.target.value as Scope; const run = matchingReview?.run ?? sessionRuns.find(item => item.root === request.root) ?? sessionRuns[0];
          setFileCollapsed(false); setRequest(value => ({ root: value.root, scope, sessionId: initialRequest.sessionId, ...(scope === 'turn' || scope === 'lastTurn' ? { root: scope === 'lastTurn' ? latestRoot.current : run?.root ?? value.root, sessionId: initialRequest.sessionId ?? run?.sessionId, runId: scope === 'turn' ? run?.id : undefined } : {}), ref: scope === 'commit' || scope === 'branch' ? refDraft : undefined }));
        }}>{(initialRequest.sessionId ? ['lastTurn', 'turn'] : ['lastTurn', 'turn', 'unstaged', 'staged', 'commit', 'branch']).map(scope => <option value={scope} key={scope}>{scope === 'turn' ? locale.startsWith('zh') ? '历史轮次' : 'History' : t[scope as Scope]}</option>)}</select>
        {matchingReview && <span className="dv-counts" aria-label={unknownFiles ? '部分统计' : '行数统计'}>{verifiedFiles.length > 0 && <><span className="dv-added">+{verifiedFiles.reduce((sum, file) => sum + file.additions, 0)}</span><span className="dv-deleted">-{verifiedFiles.reduce((sum, file) => sum + file.deletions, 0)}</span></>}{unknownFiles > 0 && <span className="dv-muted">{verifiedFiles.length ? '部分统计' : '行数未知'}</span>}</span>}</div>
        <div className="dv-top-actions">
          <button className="dv-icon-button" aria-label={t.search} title={t.search} aria-pressed={searchOpen} onClick={() => setSearchOpen(value => !value)}><ReviewIcon name="search" /></button>
          <details className="dv-menu"><summary aria-label={t.settings} title={t.settings}><ReviewIcon name="more" /></summary><div className="dv-menu-body">
            <button disabled={busy || loadingReview} onClick={() => setBootTick(value => value + 1)}>{t.refresh}</button>
            <label className="dv-check"><input type="checkbox" checked={wrap} onChange={event => saveSettings({ wordWrap: event.target.checked })} />{t.wrap}</label>
            <div className="dv-segment" role="group" aria-label={t.settings}><button aria-pressed={layout === 'unified'} onClick={() => saveSettings({ layout: 'unified' })}>{t.unified}</button><button aria-pressed={layout === 'split'} onClick={() => saveSettings({ layout: 'split' })}>{t.split}</button></div>
            <label>{t.context}<select aria-label={t.context} value={context} disabled={busy} onChange={event => { resetPage(); setContext(Number(event.target.value)); }}><option value={1}>1</option><option value={3}>3</option><option value={20}>20</option><option value={-1}>{t.full}</option></select></label>
            <button disabled={!detail?.hunks.length} onClick={() => setCollapsed(new Set(viewHunks.map(view => view.key)))}>{locale.startsWith('zh') ? '折叠全部差异' : 'Collapse all hunks'}</button>
            <button disabled={!detail?.hunks.length} onClick={() => setCollapsed(new Set())}>{locale.startsWith('zh') ? '展开全部差异' : 'Expand all hunks'}</button>
            <hr />
            <label className="dv-repository">{t.repository}<select aria-label={t.repository} value={request.root ?? ''} disabled={!boot || busy} onChange={event => { const root = event.target.value || undefined; if (request.scope === 'lastTurn') latestRoot.current = root; setFileCollapsed(false); setRequest(value => ({ ...value, root, runId: undefined, sessionId: initialRequest.sessionId })); setQuery(''); }}><option value="" disabled={request.scope !== 'lastTurn'}>{request.scope === 'lastTurn' ? locale.startsWith('zh') ? '本会话全部项目' : 'All projects in this session' : '—'}</option>{roots.map(root => <option key={root} value={root}>{boot?.repositories.find(repo => repo.root === root)?.name ?? root}</option>)}</select></label>
            <label>{t.language}<select aria-label={t.language} value={locale.startsWith('zh') ? 'zh-CN' : 'en'} onChange={event => setLocale(event.target.value)}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
            <div className="dv-toolbar" aria-label={t.batch}>{(['stage', 'unstage', 'revert', 'reapply'] as Action[]).map(action => { const files = visibleFiles.filter(file => file.actions.includes(action)).slice(0, 20); return files.length > 1 && <button key={action} disabled={busy || loadingReview} onClick={() => { if (review) { setError(''); setBatchResults([]); setConfirmation({ kind: 'batch', action, files, review }); } }}>{t[action]} · {files.length}</button>; })}</div>
            <button disabled={!boot?.runs.length || busy} onClick={() => { setError(''); setConfirmation({ kind: 'history' }); }}>{t.clearHistory}</button>
            {review?.notice && <p className="dv-muted">{review.notice}</p>}
            {context !== 3 && <p className="dv-muted">{t.expandedHint}</p>}
          </div></details>
          <button className="dv-icon-button" aria-label={locale.startsWith('zh') ? '折叠文件' : 'Collapse file'} title={locale.startsWith('zh') ? '折叠文件' : 'Collapse file'} disabled={busy || !selected || fileCollapsed} onClick={collapseFile}><ReviewIcon name="collapse" /></button>
          {onClose && <button className="dv-icon-button" aria-label={t.close} onClick={onClose} disabled={busy}><ReviewIcon name="close" /></button>}
        </div>
      </div>
      <div className="dv-toolbar dv-repo-toolbar">
        {request.scope === 'lastTurn' && matchingReview?.run && <span className="dv-turn-identity dv-muted" title={runLabel(matchingReview.run.id)}>{locale.startsWith('zh') ? '显示轮次：' : 'Showing turn: '}{runLabel(matchingReview.run.id)}</span>}
        {request.scope === 'turn' && <label className="dv-run">{t.run} <select aria-label="对话轮次" value={selectedRunId} disabled={busy || loadingReview} onChange={event => { const run = sessionRuns.find(r => r.id === event.target.value); if (run) setRequest({ scope: 'turn', sessionId: run.sessionId, runId: run.id, root: run.root }); }}>{!selectedRunId && <option value="" disabled>{loadingReview || !boot ? '正在读取轮次…' : '暂无修改记录'}</option>}{selectedRunId && !sessionRuns.some(run => run.id === selectedRunId) && <option value={selectedRunId}>当前轮次 · {matchingReview?.files.length ?? 0} 个文件</option>}{sessionRuns.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString(locale)} · {run.fileCount} 个文件 · {t[run.state]}</option>)}</select></label>}
        {(request.scope === 'commit' || request.scope === 'branch') && <form className="dv-toolbar" onSubmit={event => { event.preventDefault(); setRequest(value => ({ ...value, ref: refDraft.trim() })); }}><label>{t.ref}<input aria-label={t.ref} value={refDraft} onChange={event => setRefDraft(event.target.value)} maxLength={250} /></label><button disabled={busy || !refDraft.trim()}>{t.applyRef}</button></form>}
        {searchOpen && <input autoFocus type="search" aria-label={t.search} placeholder={t.search} value={query} onChange={event => setQuery(event.target.value)} />}
      </div>
    </header>
    {unknownFiles > 0 && <details className="dv-stats-note"><summary>{unknownFiles} 个文件暂无法显示行数</summary><p>仅统计有完整快照的文本文件。缺失历史内容的文件仍保留记录，但无法重建差异。</p></details>}
    {reviewError && matchingReview && <div className="dv-message dv-error" role="alert">{reviewError}<button onClick={() => setRefreshTick(value => value + 1)}>{t.retry}</button></div>}
    {error && <div className="dv-message dv-error" role="alert">{error}</div>}
    {status && <div className="dv-toast" role="status">{status}</div>}
    {batchResults.length > 0 && <details className="dv-message" open><summary>{t.batch}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{batchResults.map(result => `${result.ok ? '✓' : '✗'} ${result.path}: ${result.message}`).join('\n')}</pre></details>}
    {bootError ? <div className="dv-empty dv-error" role="alert">{bootError}<button onClick={() => setBootTick(value => value + 1)}>{t.retry}</button></div> : !boot && !review ? <div className="dv-empty" role="status">{t.loading}</div> : <div className="dv-workspace" ref={workspaceRef}>
      <nav className="dv-file-list" aria-label={t.files}>{(selectedIndex < 0 ? visibleFiles : visibleFiles.slice(0, selectedIndex)).map(fileRow)}</nav>
      {!visibleFiles.length && !loadingReview && !reviewError && !bootError && <p className="dv-rail-empty">{query ? t.noMatches : matchingReview?.run?.state === 'running' ? locale.startsWith('zh') ? '本轮正在运行，尚未记录文件修改。' : 'This turn is running; no file changes recorded yet.' : t.noFiles}{query && <button onClick={() => setQuery('')}>{t.clearSearch}</button>}</p>}
      <section className="dv-file-section">
      {selectedIndex >= 0 && fileRow(visibleFiles[selectedIndex])}
      <main className="dv-review" hidden={fileCollapsed || Boolean(query && selectedIndex < 0) || (!currentFile && review?.nextFileOffset == null && !loadingReview && !reviewError && !bootError && Boolean(review))} aria-busy={loadingReview || loadingDetail}>
        {loadingReview && !matchingReview ? <div className="dv-empty" role="status">{t.loading}</div> : reviewError && !matchingReview ? <div className="dv-empty dv-error" role="alert">{reviewError}<button onClick={() => setRefreshTick(value => value + 1)}>{t.retry}</button></div> : !review ? <div className="dv-empty">{t.noRoots}</div> : !currentFile ? review.files.length || review.nextFileOffset != null ? <div className="dv-empty">{review.nextFileOffset != null ? t.loading : t.chooseFile}</div> : null : <>
          <h2 className="dv-sr-only">{currentFile.path}</h2>
          <div className={`dv-diff-pane ${wrap ? 'dv-wrap' : 'dv-nowrap'}`} ref={diffPane} tabIndex={0} aria-label={`${currentFile.path} ${t.title}`}>
            {loadingDetail && !detail ? <div className="dv-empty" role="status">{t.loading}</div> : detailError && !detail ? <div className="dv-empty dv-error" role="alert">{detailError}<button onClick={() => setDetailTick(value => value + 1)}>{t.retry}</button></div> : currentFile.kind !== 'text' ? <div className="dv-empty">{t[currentFile.kind]}</div> : detail && !detail.hunks.length ? <div className="dv-empty">{currentFile.status === 'mode' ? t.mode : t.noHunks}</div> : viewHunks.map(({ key, hunk }) => <section className="dv-hunk" key={key}>
              <div className="dv-hunk-heading"><button data-hunk-nav aria-expanded={!collapsed.has(key)} onClick={() => setCollapsed(value => { const next = new Set(value); next.has(key) ? next.delete(key) : next.add(key); return next; })} aria-label={`${collapsed.has(key) ? t.collapsed : t.expanded} ${hunk.header}`}><span aria-hidden="true">{collapsed.has(key) ? '▸' : '▾'}</span> <code>{hunk.header}</code></button><div className="dv-toolbar">{context === 3 && !currentFile.oldPath && review.scope !== 'turn' && review.scope !== 'lastTurn' && actionButtons(currentFile, hunk)}</div></div>
              {!collapsed.has(key) && <DiffRows path={currentFile.path} lines={hunk.lines} layout={layout} t={t} />}
            </section>)}
          </div>
          {detail?.nextOffset != null && <div className="dv-continuation" ref={continuationRef} aria-label={t.loadMore}>{loadingMore && <span role="status">{t.loading}</span>}{detailError && <span className="dv-error" role="alert">{detailError}<button onClick={loadMore}>{t.retry}</button></span>}</div>}
        </>}
      </main>
      </section>
      {selectedIndex >= 0 && <nav className="dv-file-list" aria-label={t.files}>{visibleFiles.slice(selectedIndex + 1).map(fileRow)}</nav>}
    </div>}
    {confirmation && <Modal title={confirmation.kind === 'systemOpen' ? locale.startsWith('zh') ? '确认外部打开' : 'Confirm system open' : confirmation.kind === 'action' || confirmation.kind === 'batch' ? `${t.confirm}: ${t[confirmation.action]}` : t.clearHistory} busy={busy || openingSystemFile} onClose={() => setConfirmation(null)}>
      <p>{confirmation.kind === 'systemOpen' ? locale.startsWith('zh') ? '此文件类型可能执行程序或脚本。确认使用系统默认程序打开当前磁盘文件？' : 'This file type may execute a program or script. Open the current disk file with its default app?' : confirmation.kind === 'batch' ? t.batchHint : confirmation.kind === 'action' ? t.confirmHint : t.clearHint}</p>
      {confirmation.kind === 'systemOpen' && <p>{confirmation.file.absolutePath ?? `${confirmation.review.root}/${confirmation.file.path}`}</p>}
      {confirmation.kind === 'batch' && <><p>{confirmation.review.root} · {t[confirmation.review.scope]}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{confirmation.files.map(file => file.path).join('\n')}</pre></>}
      {confirmation.kind === 'action' ? <dl className="dv-target"><dt>{t.repository}</dt><dd>{confirmation.review.root}</dd><dt>{t.scope}</dt><dd>{t[confirmation.review.scope]}</dd><dt>{t.target}</dt><dd>{confirmation.file.path}{confirmation.file.oldPath && <> ← {confirmation.file.oldPath}</>}</dd><dt>{t.action}</dt><dd>{t[confirmation.action]} · {confirmation.hunk ? `${t.hunk} ${confirmation.hunk.header}` : t.wholeFile}</dd></dl> : confirmation.kind === 'history' ? <p>{t.history}: {boot?.runs.length ?? 0}</p> : null}
      {error && <p className="dv-error" role="alert">{error}</p>}<div className="dv-dialog-actions"><button disabled={busy} onClick={() => setConfirmation(null)} autoFocus>{t.cancel}</button><button className="dv-primary" disabled={busy} onClick={confirmOperation}>{busy ? t.loading : t.confirm}</button></div>
    </Modal>}
  </section>;
}
export default ReviewApp;
