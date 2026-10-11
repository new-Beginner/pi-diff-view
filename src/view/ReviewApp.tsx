import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, ActionResult, Bootstrap, DiffHunk, ReviewActionRequest, ReviewFile, ReviewRequest, ReviewSummary, Scope, UiTransport } from '../core/contracts';
import { DiffRows } from './DiffRows';
import FilePath from './FilePath';
import { messages, kindLabel } from './i18n';
import { ensureBounded } from './transport';
import { useDiffDetail } from './useDiffDetail';
import './review.css';

export interface ReviewAppProps { transport: UiTransport; initialRequest?: Partial<ReviewRequest>; initialFileId?: string; navigationKey?: string; onClose?: () => void; locale?: string; base?: 'light' | 'dark' }
type Confirmation = { kind: 'action'; file: ReviewFile; action: Action; hunk?: DiffHunk; review: ReviewSummary } | { kind: 'batch'; files: ReviewFile[]; action: Action; review: ReviewSummary } | { kind: 'history' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function Modal({ title, children, onClose, busy }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="dv-dialog" ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}
export function ReviewApp({ transport: source, initialRequest = {}, initialFileId, navigationKey, onClose, locale: hostLocale, base: hostBase }: ReviewAppProps) {
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
  const [status, setStatus] = useState('');
  const [batchResults, setBatchResults] = useState<{ path: string; ok: boolean; message: string }[]>([]);
  const live = useRef(true);
  const scopeKey = `${request.scope}|${request.root}|${request.ref}|${request.sessionId}|${request.runId}`;
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const diffPane = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null), continuationRef = useRef<HTMLDivElement>(null);
  const validReview = review && review.scope === request.scope && review.root === request.root && (request.scope !== 'turn' || review.runId === request.runId) && review.files.some(file => file.id === selected) ? review : null;
  const { detail, loading: loadingDetail, loadingMore, error: detailError, loadMore } = useDiffDetail(transport, validReview?.id, selected, context, detailTick);
  useEffect(() => {
    const target = continuationRef.current;
    if (!target || !detail || detail.nextOffset == null || loadingDetail || loadingMore || detailError || fileCollapsed || detail.hunks.every(hunk => collapsed.has(hunk.id))) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { root: workspaceRef.current, rootMargin: '120px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [detail, loadingDetail, loadingMore, detailError, fileCollapsed, collapsed, loadMore]);
  useEffect(() => {
    if (detail && initialRequest.runId && (!initialFileId || selected === initialFileId)) void transport.invoke('rendererReport', { stage: 'view-targeted' }).catch(() => {});
  }, [transport, detail?.file.id, initialRequest.runId]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (hostLocale) setLocale(hostLocale); }, [hostLocale]);
  useEffect(() => { if (hostBase) setBase(hostBase); }, [hostBase]);
  useEffect(() => {
    if (!navigationKey) return;
    const next: ReviewRequest = { ...initialRequest, scope: initialRequest.scope ?? 'turn' };
    const sameReview = review?.scope === next.scope && review?.root === next.root && review?.runId === next.runId && review?.sessionId === next.sessionId;
    const target = initialFileId ?? (sameReview ? review?.files[0]?.id : undefined) ?? '';
    setRequest(next); setSelected(target); setFileCollapsed(false); setQuery('');
    setCollapsed(new Set()); setConfirmation(null); setError('');
    // Only refresh the bounded file list when the target is outside it or a prior load is still pending.
    if ((sameReview && target && !review?.files.some(file => file.id === target)) || (!review && boot)) setRefreshTick(value => value + 1);
  }, [navigationKey]);
  useEffect(() => {
    if (!navigationKey || !selected) return;
    appRef.current?.querySelector<HTMLElement>('.dv-file[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [navigationKey, selected, review]);
  useEffect(() => {
    let active = true; setBootError('');
    transport.invoke<Bootstrap>('bootstrap', { sessionId: initialRequest.sessionId }).then(data => {
      if (!active) return;
      setBoot(data); setLayout(data.settings.layout); setWrap(data.settings.wordWrap);
      if (!hostLocale) setLocale(data.locale); if (!hostBase) setBase(data.base);
      setRequest(previous => {
        if (previous.root) return previous;
        const run = data.runs.find(item => item.id === previous.runId) ?? data.runs.find(item => item.sessionId === previous.sessionId) ?? data.runs[0];
        const root = previous.scope === 'turn' || previous.scope === 'lastTurn' ? run?.root : data.repositories[0]?.root;
        return { ...previous, root, ...((previous.scope === 'turn' || previous.scope === 'lastTurn') && run ? { sessionId: previous.sessionId ?? run.sessionId, runId: previous.scope === 'turn' ? previous.runId ?? run.id : undefined } : {}) };
      });
    }).catch(err => { if (active) setBootError(errorText(err)); });
    return () => { active = false; };
  }, [transport, bootTick]);
  useEffect(() => {
    if (!boot) return;
    let active = true;
    setLoadingReview(false); setReview(null); setReviewError(''); setConfirmation(null); setCollapsed(new Set());
    if (!request.root && !request.sessionId && !request.runId) return;
    if ((request.scope === 'commit' || request.scope === 'branch') && !request.ref?.trim()) { setReviewError(t.emptyRef); return; }
    setLoadingReview(true);
    transport.invoke<ReviewSummary>('review', { ...request, focusFileId: request.scope === 'turn' && request.runId === initialRequest.runId ? initialFileId : undefined }).then(data => {
      if (!active) return;
      setReview(data); setSelected(previous => data.files.some(file => file.id === previous) ? previous : initialFileId && data.files.some(file => file.id === initialFileId) ? initialFileId : data.files[0]?.id ?? '');
    }).catch(err => { if (active) setReviewError(errorText(err)); }).finally(() => { if (active) setLoadingReview(false); });
    return () => { active = false; };
  }, [transport, boot, scopeKey, refreshTick]);
  const resetPage = () => { setCollapsed(new Set()); };
  const currentFile = detail?.file.id === selected ? detail.file : review?.files.find(file => file.id === selected);
  const visibleFiles = review?.files.filter(file => `${file.path} ${file.oldPath ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const sessionRuns = boot?.runs.filter(run => !initialRequest.sessionId || run.sessionId === initialRequest.sessionId) ?? [];
  const roots = [...new Set([...(boot?.repositories.map(repo => repo.root) ?? []), ...(boot?.runs.map(run => run.root) ?? []), ...(request.root ? [request.root] : [])])];
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
      setStatus(result.message || t.actionOk); if (scopeRef.current === key) setRefreshTick(value => value + 1);
    } else if (target.kind === 'batch') {
      const result = await transport.invoke<{ results: { path: string; ok: boolean; message: string }[] }>('batchAction', { reviewId: target.review.id, action: target.action, targets: target.files.map(file => ({ fileId: file.id, fingerprint: file.fingerprint })), confirmed: true });
      if (!live.current) return;
      setConfirmation(null); setBatchResults(result.results); if (scopeRef.current === key) setRefreshTick(value => value + 1);
    } else if (target.kind === 'history') {
      await transport.invoke('clearHistory', { confirmed: true });
      if (!live.current) return;
      setConfirmation(null); setStatus(t.cleared); setBootTick(value => value + 1);
    }
  });
  const copyPatch = () => perform(async () => {
    if (!review) return;
    await transport.invoke('copyPatch', { reviewId: review.id, fileId: currentFile?.id });
    if (live.current) setStatus(t.copied);
  });
  const actionButtons = (file: ReviewFile, hunk?: DiffHunk) => file.actions.map(action => <button key={action} disabled={busy || loadingReview || loadingDetail} onClick={() => { setError(''); if (review) setConfirmation({ kind: 'action', action, file, hunk, review }); }}>{t[action]}</button>);
  const selectedIndex = visibleFiles.findIndex(file => file.id === selected);
  const fileRow = (file: ReviewFile) => <div className="dv-file-row" key={file.id}>
    <button className="dv-file" aria-current={file.id === selected ? 'true' : undefined} aria-expanded={file.id === selected && !fileCollapsed} disabled={busy} onClick={() => { if (file.id === selected) setFileCollapsed(value => !value); else { resetPage(); setSelected(file.id); setFileCollapsed(false); } }} title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} · ${t[file.status]}`}>
      <span className="dv-file-type" aria-hidden="true">{file.path.split('.').pop()?.slice(0, 3).toUpperCase() || '◇'}</span><span className="dv-file-name"><FilePath path={file.path} /></span><span className="dv-counts"><span className="dv-added">+{file.additions}</span><span className="dv-deleted">−{file.deletions}</span></span><span className="dv-file-chevron" aria-hidden="true">{file.id === selected && !fileCollapsed ? '⌃' : '⌄'}</span>
    </button>
    {file.id === selected && <details className="dv-menu dv-file-menu"><summary aria-label={t.action} title={t.action}>···</summary><div className="dv-menu-body">{actionButtons(file)}<button disabled={busy} onClick={copyPatch}>{t.copy}</button>{file.oldPath && <p>← {file.oldPath}</p>}<p className="dv-muted">{t[file.status]} · {kindLabel(file.kind, locale)}</p>{file.note && <p className="dv-muted">{file.note}</p>}</div></details>}
  </div>;
  const runLabel = (id: string) => { const run = boot?.runs.find(item => item.id === id); return run ? `${new Date(run.startedAt).toLocaleString(locale)} · ${run.prompt?.slice(0, 60) ?? run.id} · ${t[run.state]}${run.incomplete ? ` · ${t.incomplete}` : ''}` : id; };
  return <section ref={appRef} className="dv-app" data-base={base} lang={locale} aria-label={t.title} onKeyDown={event => { if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !confirmation) { event.preventDefault(); navigateHunk(event.key === 'ArrowDown' ? 1 : -1); } }}>
    <header className="dv-top">
      <div className="dv-heading">
        <select className="dv-scope" aria-label={t.scope} value={request.scope} disabled={!boot || busy} onChange={event => {
          const scope = event.target.value as Scope; const run = sessionRuns.find(item => item.root === request.root) ?? sessionRuns[0];
          setFileCollapsed(false); setRequest(value => ({ root: value.root, scope, sessionId: initialRequest.sessionId, ...(scope === 'turn' || scope === 'lastTurn' ? { root: run?.root ?? value.root, sessionId: initialRequest.sessionId ?? run?.sessionId, runId: scope === 'turn' ? run?.id : undefined } : {}), ref: scope === 'commit' || scope === 'branch' ? refDraft : undefined }));
        }}>{(['lastTurn', 'turn', 'unstaged', 'staged', 'commit', 'branch'] as Scope[]).map(scope => <option value={scope} key={scope}>{t[scope]}</option>)}</select>
        {review && <span className="dv-counts"><span className="dv-added">+{review.files.reduce((sum, file) => sum + file.additions, 0)}</span><span className="dv-deleted">−{review.files.reduce((sum, file) => sum + file.deletions, 0)}</span></span>}
        <div className="dv-top-actions">
          <button className="dv-icon-button" aria-label={t.search} title={t.search} aria-pressed={searchOpen} onClick={() => setSearchOpen(value => !value)}>⌕</button>
          <details className="dv-menu"><summary aria-label={t.settings} title={t.settings}>···</summary><div className="dv-menu-body">
            <button disabled={busy || loadingReview} onClick={() => setBootTick(value => value + 1)}>{t.refresh}</button>
            <label className="dv-check"><input type="checkbox" checked={wrap} onChange={event => saveSettings({ wordWrap: event.target.checked })} />{t.wrap}</label>
            <div className="dv-segment" role="group" aria-label={t.settings}><button aria-pressed={layout === 'unified'} onClick={() => saveSettings({ layout: 'unified' })}>{t.unified}</button><button aria-pressed={layout === 'split'} onClick={() => saveSettings({ layout: 'split' })}>{t.split}</button></div>
            <label>{t.context}<select aria-label={t.context} value={context} disabled={busy} onChange={event => { resetPage(); setContext(Number(event.target.value)); }}><option value={3}>3</option><option value={20}>20</option><option value={-1}>{t.full}</option></select></label>
            <button disabled={!detail?.hunks.length} onClick={() => setCollapsed(new Set(detail?.hunks.map(hunk => hunk.id)))}>{locale.startsWith('zh') ? '折叠全部差异' : 'Collapse all hunks'}</button>
            <button disabled={!detail?.hunks.length} onClick={() => setCollapsed(new Set())}>{locale.startsWith('zh') ? '展开全部差异' : 'Expand all hunks'}</button>
            <hr />
            <label className="dv-repository">{t.repository}<select aria-label={t.repository} value={request.root ?? ''} disabled={!boot || busy} onChange={event => { setFileCollapsed(false); setRequest(value => ({ ...value, root: event.target.value, runId: undefined, sessionId: initialRequest.sessionId })); setQuery(''); }}><option value="" disabled>—</option>{roots.map(root => <option key={root} value={root}>{boot?.repositories.find(repo => repo.root === root)?.name ?? root}</option>)}</select></label>
            <label>{t.language}<select aria-label={t.language} value={locale.startsWith('zh') ? 'zh-CN' : 'en'} onChange={event => setLocale(event.target.value)}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
            <div className="dv-toolbar" aria-label={t.batch}>{(['stage', 'unstage', 'revert', 'reapply'] as Action[]).map(action => { const files = visibleFiles.filter(file => file.actions.includes(action)).slice(0, 20); return files.length > 1 && <button key={action} disabled={busy || loadingReview} onClick={() => { if (review) { setError(''); setBatchResults([]); setConfirmation({ kind: 'batch', action, files, review }); } }}>{t[action]} · {files.length}</button>; })}</div>
            <button disabled={!boot?.runs.length || busy} onClick={() => { setError(''); setConfirmation({ kind: 'history' }); }}>{t.clearHistory}</button>
            {review?.notice && <p className="dv-muted">{review.notice}</p>}
            {context !== 3 && <p className="dv-muted">{t.expandedHint}</p>}
            {request.scope === 'turn' && <label className="dv-run">{t.run}<select aria-label={t.run} disabled={busy} value={request.runId ?? ''} onChange={event => { const run = boot?.runs.find(item => item.id === event.target.value); if (run) { setFileCollapsed(false); setRequest(value => ({ ...value, root: run.root, runId: run.id, sessionId: run.sessionId })); } }}><option value="" disabled>—</option>{sessionRuns.map(run => <option key={run.id} value={run.id}>{runLabel(run.id)}</option>)}</select></label>}
          </div></details>
          {onClose && <button className="dv-icon-button" aria-label={t.close} onClick={onClose} disabled={busy}>×</button>}
        </div>
      </div>
      <div className="dv-toolbar dv-repo-toolbar">
        {(request.scope === 'commit' || request.scope === 'branch') && <form className="dv-toolbar" onSubmit={event => { event.preventDefault(); setRequest(value => ({ ...value, ref: refDraft.trim() })); }}><label>{t.ref}<input aria-label={t.ref} value={refDraft} onChange={event => setRefDraft(event.target.value)} maxLength={250} /></label><button disabled={busy || !refDraft.trim()}>{t.applyRef}</button></form>}
        {searchOpen && <input autoFocus type="search" aria-label={t.search} placeholder={t.search} value={query} onChange={event => setQuery(event.target.value)} />}
      </div>
    </header>
    {(error || status) && <div className={`dv-message ${error ? 'dv-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}</div>}
    {batchResults.length > 0 && <details className="dv-message" open><summary>{t.batch}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{batchResults.map(result => `${result.ok ? '✓' : '✗'} ${result.path}: ${result.message}`).join('\n')}</pre></details>}
    {bootError ? <div className="dv-empty dv-error" role="alert">{bootError}<button onClick={() => setBootTick(value => value + 1)}>{t.retry}</button></div> : !boot ? <div className="dv-empty" role="status">{t.loading}</div> : <div className="dv-workspace" ref={workspaceRef}>
      <nav className="dv-file-list" aria-label={t.files}>{(selectedIndex < 0 ? visibleFiles : visibleFiles.slice(0, selectedIndex + 1)).map(fileRow)}</nav>
      {!visibleFiles.length && !loadingReview && <p className="dv-rail-empty">{query ? t.noMatches : t.noFiles}{query && <button onClick={() => setQuery('')}>{t.clearSearch}</button>}</p>}
      <main className="dv-review" hidden={fileCollapsed || Boolean(query && selectedIndex < 0)} aria-busy={loadingReview || loadingDetail}>
        {loadingReview ? <div className="dv-empty" role="status">{t.loading}</div> : reviewError ? <div className="dv-empty dv-error" role="alert">{reviewError}<button onClick={() => setRefreshTick(value => value + 1)}>{t.retry}</button></div> : !review ? <div className="dv-empty">{t.noRoots}</div> : !currentFile ? <div className="dv-empty">{review.files.length ? t.chooseFile : t.noFiles}</div> : <>
          <h2 className="dv-sr-only">{currentFile.path}</h2>
          <div className={`dv-diff-pane ${wrap ? 'dv-wrap' : 'dv-nowrap'}`} ref={diffPane} tabIndex={0} aria-label={`${currentFile.path} ${t.title}`}>
            {loadingDetail ? <div className="dv-empty" role="status">{t.loading}</div> : detailError && !detail ? <div className="dv-empty dv-error" role="alert">{detailError}<button onClick={() => setDetailTick(value => value + 1)}>{t.retry}</button></div> : currentFile.kind !== 'text' ? <div className="dv-empty">{t[currentFile.kind]}</div> : detail && !detail.hunks.length ? <div className="dv-empty">{currentFile.status === 'mode' ? t.mode : t.noHunks}</div> : detail?.hunks.map(hunk => <section className="dv-hunk" key={`${context}:${hunk.id}`}>
              <div className="dv-hunk-heading"><button data-hunk-nav aria-expanded={!collapsed.has(hunk.id)} onClick={() => setCollapsed(value => { const next = new Set(value); next.has(hunk.id) ? next.delete(hunk.id) : next.add(hunk.id); return next; })} aria-label={`${collapsed.has(hunk.id) ? t.collapsed : t.expanded} ${hunk.header}`}><span aria-hidden="true">{collapsed.has(hunk.id) ? '▸' : '▾'}</span> <code>{hunk.header}</code></button><div className="dv-toolbar">{context === 3 && !currentFile.oldPath && review.scope !== 'turn' && review.scope !== 'lastTurn' && actionButtons(currentFile, hunk)}</div></div>
              {!collapsed.has(hunk.id) && <DiffRows path={currentFile.path} lines={hunk.lines} layout={layout} t={t} />}
            </section>)}
          </div>
          {detail?.nextOffset != null && <div className="dv-continuation" ref={continuationRef} aria-label={t.loadMore}>{loadingMore && <span role="status">{t.loading}</span>}{detailError && <span className="dv-error" role="alert">{detailError}<button onClick={loadMore}>{t.retry}</button></span>}</div>}
        </>}
      </main>
      {selectedIndex >= 0 && <nav className="dv-file-list" aria-label={t.files}>{visibleFiles.slice(selectedIndex + 1).map(fileRow)}</nav>}
    </div>}
    {confirmation && <Modal title={confirmation.kind === 'action' || confirmation.kind === 'batch' ? `${t.confirm}: ${t[confirmation.action]}` : t.clearHistory} busy={busy} onClose={() => setConfirmation(null)}>
      <p>{confirmation.kind === 'batch' ? t.batchHint : confirmation.kind === 'action' ? t.confirmHint : t.clearHint}</p>
      {confirmation.kind === 'batch' && <><p>{confirmation.review.root} · {t[confirmation.review.scope]}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{confirmation.files.map(file => file.path).join('\n')}</pre></>}
      {confirmation.kind === 'action' ? <dl className="dv-target"><dt>{t.repository}</dt><dd>{confirmation.review.root}</dd><dt>{t.scope}</dt><dd>{t[confirmation.review.scope]}</dd><dt>{t.target}</dt><dd>{confirmation.file.path}{confirmation.file.oldPath && <> ← {confirmation.file.oldPath}</>}</dd><dt>{t.action}</dt><dd>{t[confirmation.action]} · {confirmation.hunk ? `${t.hunk} ${confirmation.hunk.header}` : t.wholeFile}</dd></dl> : confirmation.kind === 'history' ? <p>{t.history}: {boot?.runs.length ?? 0}</p> : null}
      {error && <p className="dv-error" role="alert">{error}</p>}<div className="dv-dialog-actions"><button disabled={busy} onClick={() => setConfirmation(null)} autoFocus>{t.cancel}</button><button className="dv-primary" disabled={busy} onClick={confirmOperation}>{busy ? t.loading : t.confirm}</button></div>
    </Modal>}
  </section>;
}
export default ReviewApp;
