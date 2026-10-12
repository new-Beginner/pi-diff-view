import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReviewFile, RunSummary, TurnSummary, UiTransport } from '../core/contracts';
import FilePath from '../view/FilePath';
import { adaptEntryExtraViewport } from './entry-extra-layout';
export interface TurnChangeSummaryProps { run: RunSummary; transport: UiTransport; locale: string; base: 'light' | 'dark'; initialSummary?: TurnSummary; onOpen(file?: ReviewFile): Promise<void>; }
export default function TurnChangeSummary({ run, transport, locale, base, initialSummary, onOpen }: TurnChangeSummaryProps) {
  const zh = locale.startsWith('zh');
  const [summary, setSummary] = useState<TurnSummary | null>(initialSummary ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  const cardRef = useRef<HTMLElement>(null);
  const [hostExpanded, setHostExpanded] = useState(false);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card) return adaptEntryExtraViewport(card, setHostExpanded);
  }, [run.id, summary?.fileCount === 0]);
  useEffect(() => {
    let active = true; live.current = true; setError('');
    if (!initialSummary) transport.invoke<TurnSummary>('turnSummary', { runId: run.id, sessionId: run.sessionId, limit: 40 }).then(data => { if (active) setSummary(data); }).catch(err => { if (active) setError(String(err?.message ?? err)); });
    return () => { active = false; live.current = false; };
  }, [transport, run.id, run.sessionId, initialSummary]);
  useEffect(() => { setSummary(initialSummary ?? null); }, [run.id, run.sessionId]);
  useEffect(() => { if (initialSummary) setSummary(previous => previous && previous.fileCount === initialSummary.fileCount && previous.additions === initialSummary.additions && previous.deletions === initialSummary.deletions && previous.unknownFileCount === initialSummary.unknownFileCount && initialSummary.files.every(file => previous.files.some(old => old.id === file.id && old.fingerprint === file.fingerprint && old.kind === file.kind && old.statsKnown === file.statsKnown)) ? { ...initialSummary, files: previous.files, nextOffset: previous.nextOffset } : initialSummary); }, [initialSummary]);
  const open = async (file?: ReviewFile) => {
    if (busy) return; setBusy(true); setError('');
    try { await onOpen(file); } catch (err) { if (live.current) setError(String((err as Error).message ?? err)); }
    finally { if (live.current) setBusy(false); }
  };
  const loadMore = async () => {
    if (!summary || busy || summary.nextOffset == null) return;
    setBusy(true); setError('');
    try {
      const page = await transport.invoke<TurnSummary>('turnSummary', { runId: run.id, sessionId: run.sessionId, offset: summary.nextOffset, limit: 40 });
      if (page.runId !== run.id || page.sessionId !== run.sessionId || page.offset !== summary.nextOffset || (page.nextOffset != null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= page.offset || !page.files.length))) throw new Error(zh ? '无效的文件列表分页，请重试。' : 'Invalid file-list page; retry.');
      if (live.current) setSummary(previous => previous && previous.runId === page.runId && previous.sessionId === page.sessionId ? { ...page, offset: 0, files: [...previous.files, ...page.files.filter(file => !previous.files.some(old => old.id === file.id))] } : previous);
    } catch (err) { if (live.current) setError(String((err as Error).message ?? err)); }
    finally { if (live.current) setBusy(false); }
  };
  useEffect(() => {
    if (hostExpanded && summary?.nextOffset != null && !busy && !error) void loadMore();
  }, [hostExpanded, summary, busy, error]);
  // Empty event sets have no card; recorded net-zero events retain file entries.
  if (summary?.fileCount === 0 && !error) return null;
  // The host reply owns the only expand/collapse control; this card only pages metadata.
  const files = summary?.files ?? [];
  return <div className="dv-turn-layout"><section ref={cardRef} className="dv-turn-card dv-reply" data-base={base} aria-label={zh ? '本次任务文件变更' : 'Files changed in this task'}>
    <header className="dv-turn-head"><span className="dv-turn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="4" /><path d="M9 9h6M12 6v6M9 16h6" /></svg></span><div className="dv-turn-label"><strong>{summary ? zh ? `已编辑 ${summary.fileCount} 个文件` : `${summary.fileCount} files changed` : zh ? '正在读取本次变更…' : 'Loading task changes…'}</strong>{summary && <span className="dv-turn-counts">{(summary.unknownFileCount ?? 0) < summary.fileCount && <><span className="dv-turn-add">+{summary.additions}</span><span className="dv-turn-del">−{summary.deletions}</span></>}{!!summary.unknownFileCount && <span>{zh ? summary.unknownFileCount >= summary.fileCount ? '行数未知' : '部分统计' : 'Partial / unknown totals'}</span>}</span>}</div><button className="dv-turn-open" disabled={busy || !summary} onClick={() => void open()}>{busy ? zh ? '打开中…' : 'Opening…' : zh ? '查看变更' : 'View changes'}</button></header>
    <div className="dv-turn-directory" role="region" aria-label={zh ? '文件目录' : 'File directory'} tabIndex={0}>
    {!!files.length && <div className="dv-turn-files">{files.map(file => {
      const known = file.kind === 'text' && file.statsKnown !== false;
      const label = file.kind === 'binary' ? zh ? '二进制文件' : 'Binary file' : file.kind === 'large' ? zh ? '文件过大' : 'Large file' : zh ? '快照不完整' : 'Incomplete snapshot';
      return <button key={file.id} className="dv-turn-file" title={[file.absolutePath ?? file.path, file.note].filter(Boolean).join('\n')} disabled={busy} onClick={() => void open(file)}><span className="dv-turn-path"><FilePath path={file.path} />{file.origin === 'external' && <small>{zh ? '工作区外 · 只读' : 'Outside workspace · read-only'}</small>}</span>{known ? <span className="dv-turn-counts"><span className="dv-turn-add">+{file.additions}</span><span className="dv-turn-del">−{file.deletions}</span></span> : <span className="dv-turn-unknown" title={label}>{zh ? '行数未知' : 'Unknown totals'}</span>}</button>;
    })}</div>}
    {(summary?.unknownFileCount || summary?.files.some(file => file.statsKnown === false || file.kind !== 'text')) ? <details className="dv-turn-stats-note"><summary>{zh ? '统计说明' : 'About these totals'}</summary><p>{zh ? '仅统计有完整快照的文本文件；缺失历史内容的文件不计入行数。' : 'Totals include text files with complete snapshots; missing historical content is excluded.'}</p></details> : null}
    {summary?.nextOffset != null && <footer className="dv-turn-foot"><button disabled={busy} onClick={() => void loadMore()}>{busy ? zh ? '加载中…' : 'Loading…' : zh ? '加载更多文件' : 'Load more files'}</button></footer>}
    {error && <p className="dv-turn-error" role="alert">{error}</p>}
    </div>
  </section><div className="dv-turn-overflow" aria-hidden="true" /></div>;
}
