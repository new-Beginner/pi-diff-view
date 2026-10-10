import React, { useEffect, useRef, useState } from 'react';
import type { ReviewFile, RunSummary, TurnSummary, UiTransport } from '../core/contracts';
export interface TurnChangeSummaryProps { run: RunSummary; transport: UiTransport; locale: string; base: 'light' | 'dark'; onOpen(file?: ReviewFile): Promise<void>; }
export default function TurnChangeSummary({ run, transport, locale, base, onOpen }: TurnChangeSummaryProps) {
  const zh = locale.startsWith('zh');
  const [summary, setSummary] = useState<TurnSummary | null>(null);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => {
    let active = true; live.current = true; setSummary(null); setError(''); setExpanded(false);
    transport.invoke<TurnSummary>('turnSummary', { runId: run.id, sessionId: run.sessionId, limit: 3 }).then(data => { if (active) setSummary(data); }).catch(err => { if (active) setError(String(err?.message ?? err)); });
    return () => { active = false; live.current = false; };
  }, [transport, run.id, run.sessionId]);
  const open = async (file?: ReviewFile) => {
    if (busy) return; setBusy(true); setError('');
    try { await onOpen(file); } catch (err) { if (live.current) setError(String((err as Error).message ?? err)); }
    finally { if (live.current) setBusy(false); }
  };
  const expand = async (loadMore = false) => {
    if (!summary || busy) return;
    if (expanded && !loadMore) { setExpanded(false); return; }
    if ((!loadMore && summary.files.length > 3) || summary.nextOffset == null) { setExpanded(true); return; }
    setBusy(true); setError('');
    try {
      const page = await transport.invoke<TurnSummary>('turnSummary', { runId: run.id, sessionId: run.sessionId, offset: summary.nextOffset, limit: 40 });
      if (live.current) { setSummary(previous => previous && ({ ...page, offset: 0, files: [...previous.files, ...page.files.filter(file => !previous.files.some(old => old.id === file.id))] })); setExpanded(true); }
    } catch (err) { if (live.current) setError(String((err as Error).message ?? err)); }
    finally { if (live.current) setBusy(false); }
  };
  // A successfully loaded zero-net-change task produces no empty card.
  if (summary?.fileCount === 0 && !error) return null;
  const files = summary ? expanded ? summary.files : summary.files.slice(0, 3) : [];
  return <section className="dv-turn-card dv-reply" data-base={base} aria-label={zh ? '本次任务文件变更' : 'Files changed in this task'}>
    <header className="dv-turn-head"><span className="dv-turn-icon" aria-hidden="true">±</span><div className="dv-turn-label"><strong>{summary ? zh ? `已更改 ${summary.fileCount} 个文件` : `${summary.fileCount} files changed` : zh ? '正在读取本次变更…' : 'Loading task changes…'}</strong>{summary && <span className="dv-turn-counts"><span className="dv-turn-add">+{summary.additions}</span><span className="dv-turn-del">−{summary.deletions}</span></span>}</div><button className="dv-turn-open" disabled={busy || !summary} onClick={() => void open()}>{busy ? zh ? '打开中…' : 'Opening…' : zh ? '查看变更' : 'View changes'}</button></header>
    {!!files.length && <div className="dv-turn-files">{files.map(file => <button key={file.id} className="dv-turn-file" title={file.absolutePath ?? file.path} disabled={busy} onClick={() => void open(file)}><span className="dv-turn-path">{file.path}{file.origin === 'external' && <small>{zh ? '工作区外 · 只读' : 'Outside workspace · read-only'}</small>}{file.kind !== 'text' && <small>{file.kind}</small>}</span><span className="dv-turn-counts"><span className="dv-turn-add">+{file.additions}</span><span className="dv-turn-del">−{file.deletions}</span></span></button>)}</div>}
    {summary && summary.fileCount > 3 && <footer className="dv-turn-foot"><button aria-expanded={expanded} disabled={busy} onClick={() => void expand()}>{expanded ? zh ? '收起文件' : 'Collapse files' : zh ? `再显示 ${Math.max(0, summary.fileCount - 3)} 个文件` : `Show ${Math.max(0, summary.fileCount - 3)} more files`} <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>{expanded && summary.nextOffset != null && <button disabled={busy} onClick={() => void expand(true)}>{zh ? '加载更多' : 'Load more'}</button>}</footer>}
    {(summary?.incomplete || summary?.notice) && <p className="dv-turn-notice">{summary.notice || (zh ? '记录不完整：仅显示已可靠采集的文件变更。' : 'Incomplete capture: only recorded file changes are shown.')}</p>}
    {error && <p className="dv-turn-error" role="alert">{error}</p>}
  </section>;
}
