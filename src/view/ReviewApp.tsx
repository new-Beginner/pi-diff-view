import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, ActionResult, Bootstrap, DiffHunk, DiffLine, LineAnchor, ReviewActionRequest, ReviewComment, ReviewDetail, ReviewFile, ReviewRequest, ReviewSummary, Scope, UiTransport } from '../core/contracts';
import { DiffRows } from './DiffRows';
import { messages, kindLabel } from './i18n';
import { ensureBounded } from './transport';
import './review.css';

export interface ReviewAppProps { transport: UiTransport; initialRequest?: Partial<ReviewRequest>; onClose?: () => void; locale?: string; base?: 'light' | 'dark' }
type Confirmation = { kind: 'action'; file: ReviewFile; action: Action; hunk?: DiffHunk; review: ReviewSummary } | { kind: 'batch'; files: ReviewFile[]; action: Action; review: ReviewSummary } | { kind: 'history' } | { kind: 'comment'; comment: ReviewComment };
type Editor = { anchor: LineAnchor; body: string; id?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function Modal({ title, children, onClose, busy }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="dv-dialog" ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}
export function ReviewApp({ transport: source, initialRequest = {}, onClose, locale: hostLocale, base: hostBase }: ReviewAppProps) {
  const transport = useMemo(() => ensureBounded(source), [source]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [bootTick, setBootTick] = useState(0);
  const [locale, setLocale] = useState(hostLocale ?? 'zh-CN');
  const [base, setBase] = useState<'light' | 'dark'>(hostBase ?? 'light');
  const t = messages(locale);
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const [wrap, setWrap] = useState(true);
  const [request, setRequest] = useState<ReviewRequest>({ scope: initialRequest.scope ?? (initialRequest.sessionId ? 'lastTurn' : 'unstaged'), ...initialRequest });
  const [refDraft, setRefDraft] = useState(initialRequest.ref ?? '');
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [loadingReview, setLoadingReview] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [context, setContext] = useState(3);
  const [offset, setOffset] = useState(0);
  const [pageStack, setPageStack] = useState<number[]>([]);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailTick, setDetailTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [commentsError, setCommentsError] = useState('');
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsTick, setCommentsTick] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [batchResults, setBatchResults] = useState<{ path: string; ok: boolean; message: string }[]>([]);
  const live = useRef(true);
  const scopeKey = `${request.scope}|${request.root}|${request.ref}|${request.sessionId}|${request.runId}`;
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const diffPane = useRef<HTMLDivElement>(null);
  const sessionId = review?.sessionId ?? request.sessionId;
  const canInsert = Boolean(transport.insertText && sessionId && sessionId === initialRequest.sessionId);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (hostLocale) setLocale(hostLocale); }, [hostLocale]);
  useEffect(() => { if (hostBase) setBase(hostBase); }, [hostBase]);
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
    setLoadingReview(false); setReview(null); setDetail(null); setReviewError(''); setComments([]); setFeedback(''); setEditor(null); setConfirmation(null); setOffset(0); setPageStack([]); setCollapsed(new Set());
    if (!request.root && !request.sessionId && !request.runId) return;
    if ((request.scope === 'commit' || request.scope === 'branch') && !request.ref?.trim()) { setReviewError(t.emptyRef); return; }
    setLoadingReview(true);
    transport.invoke<ReviewSummary>('review', request).then(data => {
      if (!active) return;
      setReview(data); setSelected(previous => data.files.some(file => file.id === previous) ? previous : data.files[0]?.id ?? '');
    }).catch(err => { if (active) setReviewError(errorText(err)); }).finally(() => { if (active) setLoadingReview(false); });
    return () => { active = false; };
  }, [transport, boot, scopeKey, refreshTick]);
  useEffect(() => {
    setLoadingDetail(false); setDetail(null); setDetailError('');
    if (!review || !selected) return;
    let active = true; setLoadingDetail(true);
    transport.invoke<ReviewDetail>('file', { reviewId: review.id, fileId: selected, offset, limit: 80, context }).then(data => { if (active) setDetail(data); }).catch(err => { if (active) setDetailError(errorText(err)); }).finally(() => { if (active) setLoadingDetail(false); });
    return () => { active = false; };
  }, [transport, review, selected, offset, context, detailTick]);
  useEffect(() => {
    setLoadingComments(false); setFeedbackLoading(false); setCommentsError(''); setFeedback(''); setFeedbackError('');
    if (!review) return;
    let active = true;
    setLoadingComments(true);
    transport.invoke<ReviewComment[]>('comments', { reviewId: review.id, sessionId }).then(data => { if (active) setComments(data); }).catch(err => { if (active) setCommentsError(errorText(err)); }).finally(() => { if (active) setLoadingComments(false); });
    setFeedbackLoading(true);
    transport.invoke<{ text: string }>('feedback', { reviewId: review.id, sessionId }).then(data => { if (active) setFeedback(data.text); }).catch(err => { if (active) setFeedbackError(errorText(err)); }).finally(() => { if (active) setFeedbackLoading(false); });
    return () => { active = false; };
  }, [transport, review, sessionId, commentsTick]);
  const resetPage = () => { setOffset(0); setPageStack([]); setCollapsed(new Set()); };
  const currentFile = detail?.file ?? review?.files.find(file => file.id === selected);
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
  const openComment = (line: DiffLine, side: 'old' | 'new', hunk: DiffHunk) => {
    if (!currentFile || !review) return;
    const lineNumber = side === 'old' ? line.oldLine : line.newLine;
    if (lineNumber == null) return;
    const sideLines = hunk.lines.filter(item => side === 'old' ? item.oldLine != null : item.newLine != null);
    const index = sideLines.indexOf(line);
    setError(''); setEditor({ body: '', anchor: { path: currentFile.path, fingerprint: currentFile.fingerprint, scope: review.scope, root: review.root, side, line: lineNumber, text: line.text, excerpt: sideLines.slice(Math.max(0, index - 2), index + 3).map(item => item.text).join('\n').slice(0, 3000), runId: review.runId } });
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
      setConfirmation(null); setStatus(t.cleared); setBootTick(value => value + 1); setComments([]);
    } else {
      await transport.invoke('deleteComment', { id: target.comment.id });
      if (!live.current) return;
      setConfirmation(null); setStatus(t.commentDeleted); setCommentsTick(value => value + 1);
    }
  });
  const copyPatch = () => perform(async () => {
    if (!review) return;
    await transport.invoke('copyPatch', { reviewId: review.id, fileId: currentFile?.id });
    if (live.current) setStatus(t.copied);
  });
  const actionButtons = (file: ReviewFile, hunk?: DiffHunk) => file.actions.map(action => <button key={action} disabled={busy || loadingReview || loadingDetail} onClick={() => { setError(''); if (review) setConfirmation({ kind: 'action', action, file, hunk, review }); }}>{t[action]}</button>);
  const runLabel = (id: string) => { const run = boot?.runs.find(item => item.id === id); return run ? `${new Date(run.startedAt).toLocaleString(locale)} · ${run.prompt?.slice(0, 60) ?? run.id} · ${t[run.state]}${run.incomplete ? ` · ${t.incomplete}` : ''}` : id; };
  return <section className="dv-app" data-base={base} lang={locale} aria-label={t.title} onKeyDown={event => { if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !editor && !confirmation) { event.preventDefault(); navigateHunk(event.key === 'ArrowDown' ? 1 : -1); } }}>
    <header className="dv-top">
      <div className="dv-heading"><h1>{t.title}</h1>{review && <span className="dv-counts"><span className="dv-added">+{review.files.reduce((sum, file) => sum + file.additions, 0)}</span><span className="dv-deleted">−{review.files.reduce((sum, file) => sum + file.deletions, 0)}</span></span>}<div className="dv-toolbar">
        <label>{t.language}<select aria-label={t.language} value={locale.startsWith('zh') ? 'zh-CN' : 'en'} onChange={event => setLocale(event.target.value)}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
        <label>{t.theme}<select aria-label={t.theme} value={base} onChange={event => setBase(event.target.value as 'light' | 'dark')}><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></label>
        {onClose && <button onClick={onClose} disabled={busy}>{t.close}</button>}
      </div></div>
      <div className="dv-toolbar dv-repo-toolbar">
        <label className="dv-repository">{t.repository}<select aria-label={t.repository} value={request.root ?? ''} disabled={!boot || busy} onChange={event => { setRequest(value => ({ ...value, root: event.target.value, runId: undefined, sessionId: initialRequest.sessionId })); setQuery(''); }}><option value="" disabled>—</option>{roots.map(root => <option key={root} value={root}>{boot?.repositories.find(repo => repo.root === root)?.name ?? root} — {root}</option>)}</select></label>
        <label>{t.scope}<select aria-label={t.scope} value={request.scope} disabled={!boot || busy} onChange={event => {
          const scope = event.target.value as Scope; const run = sessionRuns.find(item => item.root === request.root) ?? sessionRuns[0];
          setRequest(value => ({ root: value.root, scope, sessionId: initialRequest.sessionId, ...(scope === 'turn' || scope === 'lastTurn' ? { root: run?.root ?? value.root, sessionId: initialRequest.sessionId ?? run?.sessionId, runId: scope === 'turn' ? run?.id : undefined } : {}), ref: scope === 'commit' || scope === 'branch' ? refDraft : undefined }));
        }}>{(['unstaged', 'staged', 'commit', 'branch', 'lastTurn', 'turn'] as Scope[]).map(scope => <option value={scope} key={scope}>{t[scope]}</option>)}</select></label>
        {request.scope === 'turn' && <label className="dv-run">{t.run}<select aria-label={t.run} disabled={busy} value={request.runId ?? ''} onChange={event => { const run = boot?.runs.find(item => item.id === event.target.value); if (run) setRequest(value => ({ ...value, root: run.root, runId: run.id, sessionId: run.sessionId })); }}><option value="" disabled>—</option>{sessionRuns.map(run => <option key={run.id} value={run.id}>{runLabel(run.id)}</option>)}</select></label>}
        {(request.scope === 'commit' || request.scope === 'branch') && <form className="dv-toolbar" onSubmit={event => { event.preventDefault(); setRequest(value => ({ ...value, ref: refDraft.trim() })); }}><label>{t.ref}<input aria-label={t.ref} value={refDraft} onChange={event => setRefDraft(event.target.value)} maxLength={250} /></label><button disabled={busy || !refDraft.trim()}>{t.applyRef}</button></form>}
        <button disabled={busy || loadingReview} onClick={() => setBootTick(value => value + 1)}>{t.refresh}</button>
        <button disabled={!boot?.runs.length || busy} onClick={() => { setError(''); setConfirmation({ kind: 'history' }); }}>{t.clearHistory}</button>
      </div>
      {review?.notice && <p className="dv-notice">{review.notice}</p>}
      {request.runId && boot?.runs.find(run => run.id === request.runId)?.incomplete && <p className="dv-notice">{t.incomplete}</p>}
    </header>
    {(error || status) && <div className={`dv-message ${error ? 'dv-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}</div>}
    {batchResults.length > 0 && <details className="dv-message" open><summary>{t.batch}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{batchResults.map(result => `${result.ok ? '✓' : '✗'} ${result.path}: ${result.message}`).join('\n')}</pre></details>}
    {bootError ? <div className="dv-empty dv-error" role="alert">{bootError}<button onClick={() => setBootTick(value => value + 1)}>{t.retry}</button></div> : !boot ? <div className="dv-empty" role="status">{t.loading}</div> : <div className="dv-workspace">
      <aside className="dv-files" aria-label={t.files}>
        <div className="dv-file-search"><strong>{t.files} <span className="dv-muted">{review?.files.length ?? 0}</span></strong><input type="search" aria-label={t.search} placeholder={t.search} value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="dv-toolbar" aria-label={t.batch}>{(['stage', 'unstage', 'revert', 'reapply'] as Action[]).map(action => { const files = visibleFiles.filter(file => file.actions.includes(action)).slice(0, 20); return files.length > 1 && <button key={action} disabled={busy || loadingReview} onClick={() => { if (review) { setError(''); setBatchResults([]); setConfirmation({ kind: 'batch', action, files, review }); } }}>{t[action]} · {files.length}</button>; })}</div>
        <nav className="dv-file-list" aria-label={t.files}>{visibleFiles.map(file => <button className="dv-file" key={file.id} aria-current={file.id === selected ? 'true' : undefined} disabled={busy} onClick={() => { resetPage(); setSelected(file.id); setEditor(null); }} title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`}>
          <span className="dv-file-name">{file.path.split('/').pop()}</span><span className="dv-counts"><span className="dv-added">+{file.additions}</span><span className="dv-deleted">−{file.deletions}</span></span>
          <span className="dv-file-path">{file.path}{file.oldPath && <><br />← {file.oldPath}</>}</span><span className="dv-file-status">{t[file.status]}{file.kind !== 'text' ? ` · ${kindLabel(file.kind, locale)}` : ''}{file.state === 'reverted' ? ` · ${t.reverted}` : ''}</span>
        </button>)}</nav>
        {!visibleFiles.length && !loadingReview && <p className="dv-rail-empty">{query ? t.noMatches : t.noFiles}{query && <button onClick={() => setQuery('')}>{t.clearSearch}</button>}</p>}
      </aside>
      <main className="dv-review" aria-busy={loadingReview || loadingDetail}>
        {loadingReview ? <div className="dv-empty" role="status">{t.loading}</div> : reviewError ? <div className="dv-empty dv-error" role="alert">{reviewError}<button onClick={() => setRefreshTick(value => value + 1)}>{t.retry}</button></div> : !review ? <div className="dv-empty">{t.noRoots}</div> : !currentFile ? <div className="dv-empty">{review.files.length ? t.chooseFile : t.noFiles}</div> : <>
          <div className="dv-file-heading"><div><h2>{currentFile.path}</h2>{currentFile.oldPath && <p className="dv-muted">← {currentFile.oldPath}</p>}<span className="dv-added">+{currentFile.additions}</span> <span className="dv-deleted">−{currentFile.deletions}</span> <span className="dv-muted">{t[currentFile.status]}</span></div><div className="dv-toolbar">{actionButtons(currentFile)}<button disabled={busy} onClick={copyPatch}>{t.copy}</button></div></div>
          <div className="dv-display-toolbar dv-toolbar" aria-label={t.settings}>
            <div className="dv-segment" role="group" aria-label={t.settings}><button aria-pressed={layout === 'unified'} onClick={() => saveSettings({ layout: 'unified' })}>{t.unified}</button><button aria-pressed={layout === 'split'} onClick={() => saveSettings({ layout: 'split' })}>{t.split}</button></div>
            <label className="dv-check"><input type="checkbox" checked={wrap} onChange={event => saveSettings({ wordWrap: event.target.checked })} />{t.wrap}</label>
            <label>{t.context}<select aria-label={t.context} value={context} disabled={busy} onChange={event => { resetPage(); setContext(Number(event.target.value)); }}><option value={3}>3</option><option value={20}>20</option><option value={-1}>{t.full}</option></select></label>
            <button onClick={() => navigateHunk(-1)} disabled={!detail?.hunks.length} title={t.keyboard}>{t.previousHunk}</button><button onClick={() => navigateHunk(1)} disabled={!detail?.hunks.length} title={t.keyboard}>{t.nextHunk}</button>
          </div>
          {context !== 3 && <p className="dv-notice">{t.expandedHint}</p>}
          {currentFile.note && <p className="dv-notice">{currentFile.note}</p>}
          <div className={`dv-diff-pane ${wrap ? 'dv-wrap' : 'dv-nowrap'}`} ref={diffPane} tabIndex={0} aria-label={`${currentFile.path} ${t.title}`}>
            {loadingDetail ? <div className="dv-empty" role="status">{t.loading}</div> : detailError ? <div className="dv-empty dv-error" role="alert">{detailError}<button onClick={() => setDetailTick(value => value + 1)}>{t.retry}</button></div> : currentFile.kind !== 'text' ? <div className="dv-empty">{t[currentFile.kind]}</div> : detail && !detail.hunks.length ? <div className="dv-empty">{currentFile.status === 'mode' ? t.mode : t.noHunks}</div> : detail?.hunks.map((hunk, index) => <section className="dv-hunk" key={`${context}:${offset}:${hunk.id}`} style={{ '--dv-stagger': `${Math.min(index, 4) * 20}ms` } as React.CSSProperties}>
              <div className="dv-hunk-heading"><button data-hunk-nav aria-expanded={!collapsed.has(hunk.id)} onClick={() => setCollapsed(value => { const next = new Set(value); next.has(hunk.id) ? next.delete(hunk.id) : next.add(hunk.id); return next; })} aria-label={`${collapsed.has(hunk.id) ? t.collapsed : t.expanded} ${hunk.header}`}><span aria-hidden="true">{collapsed.has(hunk.id) ? '▸' : '▾'}</span> <code>{hunk.header}</code></button><div className="dv-toolbar">{context === 3 && review.scope !== 'turn' && review.scope !== 'lastTurn' && actionButtons(currentFile, hunk)}</div></div>
              {!collapsed.has(hunk.id) && <DiffRows path={currentFile.path} lines={hunk.lines} layout={layout} t={t} disabled={busy} onLine={(line, side) => openComment(line, side, hunk)} />}
            </section>)}
          </div>
          {detail && detail.totalRows > 0 && <footer className="dv-pagination"><span>{t.page} {detail.offset + 1}–{detail.offset + detail.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)} {t.of} {detail.totalRows}</span><div className="dv-toolbar"><button disabled={!pageStack.length || busy || loadingDetail} onClick={() => { const pages = [...pageStack]; setOffset(pages.pop() ?? 0); setPageStack(pages); diffPane.current?.scrollTo(0, 0); }}>{t.previous}</button><button disabled={detail.nextOffset == null || busy || loadingDetail} onClick={() => { if (detail.nextOffset != null) { setPageStack(value => [...value, offset]); setOffset(detail.nextOffset); diffPane.current?.scrollTo(0, 0); } }}>{t.next}</button></div>{detail.totalRows > 80 && <small>{t.continuation}</small>}</footer>}
          <details className="dv-comments" open><summary>{t.summary} ({comments.length})</summary>
            {commentsError && <p className="dv-error" role="alert">{t.commentsFailed}: {commentsError}<button onClick={() => setCommentsTick(value => value + 1)}>{t.retry}</button></p>}
            {loadingComments ? <p role="status">{t.loading}</p> : !comments.length && !commentsError && <p className="dv-muted">{t.noComments}</p>}
            <div className="dv-comment-list">{comments.map(comment => <article className="dv-comment" key={comment.id}><header><strong>{comment.anchor.path}</strong><span>{t[comment.anchor.side]}:{comment.anchor.line}</span><div className="dv-toolbar"><button disabled={busy} onClick={() => { setError(''); setEditor({ id: comment.id, body: comment.body, anchor: comment.anchor }); }}>{t.edit}</button><button disabled={busy} onClick={() => { setError(''); setConfirmation({ kind: 'comment', comment }); }}>{t.delete}</button></div></header>{comment.stale && <p className="dv-stale">{t.stale}</p>}<p className="dv-comment-body">{comment.body}</p><details><summary>{t.deletedExcerpt}</summary><pre>{comment.anchor.excerpt}</pre></details></article>)}</div>
            <details className="dv-feedback"><summary>{t.feedback}</summary>{feedbackLoading ? <p role="status">{t.loading}</p> : feedbackError ? <p className="dv-error" role="alert">{t.feedbackFailed}: {feedbackError}</p> : feedback ? <textarea readOnly aria-label={t.feedbackCopy} value={feedback} rows={5} /> : <p className="dv-muted">{t.feedbackEmpty}</p>}
              {canInsert ? <><button disabled={!feedback || feedbackLoading || busy} onClick={() => {
                // insertText is invoked in this user gesture, never after an awaited call.
                if (!live.current || !feedback || !canInsert) return;
                setError(''); transport.insertText!(feedback).catch(err => { if (live.current) setError(errorText(err)); });
              }}>{t.insert}</button><p className="dv-muted">{t.feedbackHint}</p></> : <p className="dv-muted">{t.feedbackNoSession}</p>}
            </details>
          </details>
        </>}
      </main>
    </div>}
    {editor && <Modal title={editor.id ? t.edit : t.addComment} busy={busy} onClose={() => setEditor(null)}><form onSubmit={event => { event.preventDefault(); const draft = editor; const key = scopeRef.current; void perform(async () => {
      if (!draft.body.trim() || draft.body.length > 4000) throw new Error(t.commentLimit);
      await transport.invoke<ReviewComment>('saveComment', { id: draft.id, anchor: draft.anchor, body: draft.body.trim(), sessionId });
      if (!live.current || scopeRef.current !== key) return;
      setEditor(null); setStatus(t.commentSaved); setCommentsTick(value => value + 1);
    }); }}><p className="dv-anchor">{editor.anchor.path} · {t[editor.anchor.side]}:{editor.anchor.line}</p><pre>{editor.anchor.excerpt}</pre><label className="dv-editor-label">{t.commentBody}<textarea aria-label={t.commentBody} autoFocus value={editor.body} maxLength={4000} rows={5} onChange={event => setEditor(value => value && ({ ...value, body: event.target.value }))} /></label>{error && <p className="dv-error" role="alert">{error}</p>}<div className="dv-dialog-actions"><button type="button" disabled={busy} onClick={() => setEditor(null)}>{t.cancel}</button><button className="dv-primary" disabled={busy || !editor.body.trim()}>{busy ? t.loading : t.save}</button></div></form></Modal>}
    {confirmation && <Modal title={confirmation.kind === 'action' || confirmation.kind === 'batch' ? `${t.confirm}: ${t[confirmation.action]}` : confirmation.kind === 'history' ? t.clearHistory : t.delete} busy={busy} onClose={() => setConfirmation(null)}>
      <p>{confirmation.kind === 'batch' ? t.batchHint : confirmation.kind === 'action' ? t.confirmHint : confirmation.kind === 'history' ? t.clearHint : t.deleteHint}</p>
      {confirmation.kind === 'batch' && <><p>{confirmation.review.root} · {t[confirmation.review.scope]}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{confirmation.files.map(file => file.path).join('\n')}</pre></>}
      {confirmation.kind === 'action' ? <dl className="dv-target"><dt>{t.repository}</dt><dd>{confirmation.review.root}</dd><dt>{t.scope}</dt><dd>{t[confirmation.review.scope]}</dd><dt>{t.target}</dt><dd>{confirmation.file.path}{confirmation.file.oldPath && <> ← {confirmation.file.oldPath}</>}</dd><dt>{t.action}</dt><dd>{t[confirmation.action]} · {confirmation.hunk ? `${t.hunk} ${confirmation.hunk.header}` : t.wholeFile}</dd></dl> : confirmation.kind === 'comment' ? <><p className="dv-anchor">{confirmation.comment.anchor.path} · {t[confirmation.comment.anchor.side]}:{confirmation.comment.anchor.line}</p><p>{confirmation.comment.body}</p></> : confirmation.kind === 'history' ? <p>{t.history}: {boot?.runs.length ?? 0}</p> : null}
      {error && <p className="dv-error" role="alert">{error}</p>}<div className="dv-dialog-actions"><button disabled={busy} onClick={() => setConfirmation(null)} autoFocus>{t.cancel}</button><button className="dv-primary" disabled={busy} onClick={confirmOperation}>{busy ? t.loading : t.confirm}</button></div>
    </Modal>}
  </section>;
}
export default ReviewApp;
