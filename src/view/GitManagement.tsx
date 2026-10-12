import { useEffect, useRef, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementArgs, ManagementBranch, ManagementCommit, ManagementEntry, ManagementStash, ManagementStatus, ManagementText } from '../git/local-management';
import FileIcon from './FileIcon';
import FilePath from './FilePath';
import ReviewIcon from './ReviewIcon';
import GitPatch from './GitPatch';
import './git-management.css';

type Page = 'workspace' | 'staged' | 'branches' | 'history' | 'blame' | 'stash';
const labels: Record<Page, string> = { workspace: '工作区', staged: '暂存区', branches: '分支', history: '历史', blame: 'Blame', stash: 'Stash' };
interface Confirmation { args: ManagementArgs; description: string; }
function blockedReason(reason = ''): string {
  if (/sensitive|credential|secret|private|public path|protected|安全|凭据/i.test(reason)) return '凭据或敏感路径';
  if (/symlink|symbolic|link|链接/i.test(reason)) return '符号链接';
  if (/regular file|director|submodule/i.test(reason)) return '目录或子模块';
  if (/traversal|relative|outside|escape|invalid.*path/i.test(reason)) return '路径不安全';
  return '受保护或不支持的文件';
}
function localizedNotice(value: string): string {
  if (value === 'No commits yet. Stage files and create the first commit.') return '暂无提交；暂存文件后可创建首次提交。';
  if (value === 'Showing at most 100 stashes.') return '最多显示 100 条 Stash。';
  return value;
}
/** Host must route gitManage through its background job transport (commit hooks can take 90s).
 * This component only uses transport.invoke('gitManage', {operation, root, ...}).
 */
export function GitManagement({ transport, root, base, active = true }: { transport: UiTransport; root?: string; base?: 'light' | 'dark'; active?: boolean }) {
  const [page, setPage] = useState<Page>('workspace');
  const [status, setStatus] = useState<ManagementStatus>();
  const [branches, setBranches] = useState<ManagementBranch[]>([]);
  const [commits, setCommits] = useState<ManagementCommit[]>([]);
  const [stashes, setStashes] = useState<ManagementStash[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ManagementText>();
  const [detailPath, setDetailPath] = useState<string>();
  const filePage = page === 'workspace' || page === 'staged';
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [name, setName] = useState(''), [newName, setNewName] = useState('');
  const [blamePath, setBlamePath] = useState(''), [includeUntracked, setIncludeUntracked] = useState(false);
  const [offset, setOffset] = useState(0), [hasMore, setHasMore] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  useEffect(() => { if (!active) setConfirmation(undefined); }, [active]);
  const generation = useRef(0), running = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const dialogRef = useRef<HTMLDialogElement>(null), openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!confirmation) return;
    const dialog = dialogRef.current, opener = openerRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, [confirmation]);
  const invoke = <T,>(args: ManagementArgs) => transport.invoke<T>('gitManage', { ...args, root });
  const refreshData = async (current: number, target: Page, skip: number, retainSelection = false) => {
    const next = await invoke<ManagementStatus>({ operation: 'status' });
    if (current !== generation.current || (retainSelection && running.current)) return;
    setStatus(next); setSelected(previous => retainSelection ? previous.filter(value => next.entries.some(entry => entry.path === value)) : []);
    if (target === 'branches') {
      const result = await invoke<{ branches: ManagementBranch[]; truncated: boolean }>({ operation: 'branches' });
      if (current === generation.current) { setBranches(result.branches); if (result.truncated) setNotice('仅显示前 200 个分支。'); }
    } else if (target === 'history') {
      const result = await invoke<{ commits: ManagementCommit[]; hasMore: boolean; notice?: string }>({ operation: 'history', skip, limit: 30 });
      if (current === generation.current) { setCommits(result.commits); setHasMore(result.hasMore); if (result.notice) setNotice(result.notice); }
    } else if (target === 'stash') {
      const result = await invoke<{ stashes: ManagementStash[]; notice?: string }>({ operation: 'stashList' });
      if (current === generation.current) { setStashes(result.stashes); if (result.notice) setNotice(result.notice); }
    }
  };
  useEffect(() => {
    const current = ++generation.current;
    running.current = true; setBusy(true); setError(''); setNotice(''); setDetail(undefined); setDetailPath(undefined); setStatus(undefined); setSelected([]); setConfirmation(undefined);
    setBranches([]); setCommits([]); setStashes([]);
    void refreshData(current, page, offset).catch(cause => { if (current === generation.current) setError(String(cause?.message ?? cause)); })
      .finally(() => { if (current === generation.current) { running.current = false; setBusy(false); } });
    return () => { generation.current++; };
    // All requests are invalidated when the project, transport or selected page changes.
  }, [root, transport, page, offset]);
  useEffect(() => {
    if (!active || !status || running.current) return;
    const current = generation.current;
    void refreshData(current, page, offset, true).catch(cause => { if (current === generation.current) setError(String(cause?.message ?? cause)); });
  }, [active]);
  const execute = async (args?: ManagementArgs, mutation = false, inlinePath?: string) => {
    if (running.current) return;
    const current = ++generation.current;
    running.current = true; setBusy(true); setError(''); setNotice(''); setDetail(undefined); setDetailPath(inlinePath);
    try {
      if (args) {
        const result = await invoke<ManagementText & { ok?: boolean }>(args);
        if (current !== generation.current) return;
        if ('text' in result) setDetail(result);
        if (mutation) { setNotice('操作已完成。'); if (args.operation === 'commit') setMessage(''); }
      }
      if (!args || mutation) await refreshData(current, page, offset);
    } catch (cause) {
      if (current === generation.current) {
        const e = cause as Error & { code?: string };
        setError(`${e.code ? `${e.code}: ` : ''}${e.message ?? String(cause)}`);
        // Failed hooks/stash apply can still modify files. Never retry an operation automatically.
        if (mutation) {
          try { await refreshData(current, page, offset); } catch { /* Preserve the actionable original error. */ }
        }
      }
    } finally { if (current === generation.current) { running.current = false; setBusy(false); } }
  };
  const ask = (args: ManagementArgs, description: string) => { openerRef.current = document.activeElement as HTMLElement | null; setConfirmation({ args, description }); };
  const changeFiles = (operation: 'stage' | 'unstage', paths: string[]) => void execute({ operation, paths }, true);
  const visible = (status?.entries ?? []).filter(entry => page === 'staged' ? ![' ', '?'].includes(entry.index) : entry.working !== ' ');
  const actionable = visible.filter(entry => !entry.blocked), protectedFiles = visible.filter(entry => !!entry.blocked);
  const selectedPaths = selected.filter(path => actionable.some(entry => entry.path === path));
  const blockedGroups = [...new Set(protectedFiles.map(entry => blockedReason(entry.blocked)))];
  const staged = (status?.entries ?? []).filter(entry => ![' ', '?'].includes(entry.index));
  const blockedStaged = staged.some(entry => !!entry.blocked);
  const toggle = (file: string) => { if (actionable.some(entry => entry.path === file)) setSelected(current => current.includes(file) ? current.filter(p => p !== file) : [...current, file]); };
  const showDiff = (entry: ManagementEntry) => {
    if (entry.blocked || running.current) return;
    if (detailPath === entry.path) { setDetailPath(undefined); setDetail(undefined); return; }
    void execute({ operation: 'diff', paths: [entry.path], scope: page === 'staged' ? 'staged' : 'workspace' }, false, entry.path);
  };
  const askDiscard = async (entry: ManagementEntry) => {
    if (running.current) return;
    const current = ++generation.current;
    openerRef.current = document.activeElement as HTMLElement | null;
    running.current = true; setBusy(true); setError('');
    try {
      const target = await invoke<{ fingerprint: string; untracked: boolean }>({ operation: 'discardPreview', paths: [entry.path] });
      if (current !== generation.current || !activeRef.current) return;
      setConfirmation({ args: { operation: 'discard', paths: [entry.path], fingerprint: target.fingerprint }, description: target.untracked ? `删除未跟踪文件 ${entry.path}？文件尚未提交，此操作不可恢复。其他文件不受影响。` : `撤销 ${entry.path} 的工作区改动，恢复为暂存区版本？不会更改暂存内容或其他文件，此操作不可恢复。` });
    } catch (cause) { if (current === generation.current) setError(String((cause as Error)?.message ?? cause)); }
    finally { if (current === generation.current) { running.current = false; setBusy(false); } }
  };
  const stashArgs = (operation: string, stash: ManagementStash): ManagementArgs => ({ operation, ref: stash.ref, oid: stash.oid });
  return <section className="git-management" data-base={base ?? (document.documentElement.dataset.base === 'dark' ? 'dark' : 'light')} aria-label="本地 Git 管理" aria-busy={busy}>
    <div className="gm-top">
    <header className="gm-header"><div><h2>本地 Git</h2><small>独立仓库管理 · 无远程操作</small></div>
      <div className="gm-top-actions">{filePage && <button className="gm-icon-button" disabled={busy || !!confirmation || !detailPath} aria-label="折叠全部文件" title="折叠全部文件" onClick={() => { setDetailPath(undefined); setDetail(undefined); }}><ReviewIcon name="collapse" /></button>}
      <button className="gm-icon-button" disabled={busy || !!confirmation} aria-label="刷新" title="刷新" onClick={() => void execute()}><ReviewIcon name="refresh" /></button></div></header>
    <p className="gm-root" title={status?.root ?? root}>{status?.root ?? root ?? '当前授权项目'}<span className="gm-branch">{status?.branch ?? (status?.head ? '分离 HEAD' : '尚无提交')}</span></p>
    <nav aria-label="Git 功能">{(Object.keys(labels) as Page[]).map(item => <button key={item} disabled={busy || !!confirmation} aria-pressed={item === page}
      onClick={() => { setPage(item); setOffset(0); }}>{labels[item]}</button>)}</nav>
    </div>
    <div className="gm-scroll" tabIndex={0} aria-label="Git 内容">
    {busy && <p role="status">正在执行 Git，请勿重复操作…</p>}
    {error && <pre className="gm-error" role="alert">{error}</pre>}
    {notice && <p className="gm-notice" role="status">{localizedNotice(notice)}</p>}
    {status && !status.head && <p className="gm-hint">仓库尚无提交。可以选择文件暂存，然后创建首次提交。</p>}
    <fieldset disabled={busy || !!confirmation} className="gm-controls">
      {filePage && <>
        <div className="gm-toolbar"><button disabled={!actionable.length} onClick={() => setSelected(actionable.map(e => e.path))}>选择全部可操作文件</button>
          <button disabled={!selectedPaths.length} onClick={() => setSelected([])}>清空选择</button>
          <button disabled={!selectedPaths.length} onClick={() => changeFiles(page === 'staged' ? 'unstage' : 'stage', selectedPaths)}>{page === 'staged' ? '取消暂存' : '暂存'}所选 ({selectedPaths.length})</button>
          <button disabled={!selectedPaths.length} onClick={() => void execute({ operation: 'diff', scope: page, paths: selectedPaths })}>所选差异</button></div>
        <ul className="gm-list gm-files" aria-label="可操作文件">{actionable.map(entry => <li key={entry.path} className={selectedPaths.includes(entry.path) ? 'gm-selected' : ''}>
          <div className="gm-file-row">
          <input type="checkbox" aria-label={`选择 ${entry.path}`} checked={selectedPaths.includes(entry.path)} onChange={() => toggle(entry.path)} />
          <button className="gm-path gm-file" aria-label={entry.path} aria-expanded={detailPath === entry.path} onClick={() => showDiff(entry)} title={entry.path}>
            <FileIcon path={entry.path} /><span className="gm-file-name"><FilePath path={entry.path} /></span><span className="gm-file-chevron"><ReviewIcon name="chevron" /></span>
          </button>
          <code className="gm-file-status" title="暂存区 / 工作区状态">{entry.index}{entry.working}</code>
          <button className="gm-icon-button" aria-label={`${page === 'staged' ? '取消暂存' : '暂存'} ${entry.path}`} title={page === 'staged' ? '取消暂存' : '暂存'} onClick={() => changeFiles(page === 'staged' ? 'unstage' : 'stage', [entry.path])}><ReviewIcon name={page === 'staged' ? 'unstage' : 'stage'} /></button>
          {page === 'workspace' && <button className="gm-icon-button gm-discard" aria-label={`撤销 ${entry.path}`} title="撤销工作区改动" onClick={() => void askDiscard(entry)}><ReviewIcon name="undo" /></button>}
          </div>
          {detailPath === entry.path && <section className="gm-inline-diff" aria-label={`${entry.path} 差异`}>{busy ? <p role="status">正在读取差异…</p> : detail ? <GitPatch detail={detail} /> : <p className="gm-hint">差异加载失败，请重新展开。</p>}</section>}
        </li>)}</ul>
        {!visible.length && !busy && <p className="gm-hint">没有{page === 'staged' ? '已暂存' : '工作区'}改动。</p>}
        {protectedFiles.length > 0 && <details className="gm-protected"><summary>已排除 {protectedFiles.length} 个受保护文件（不可操作）</summary>
          <p className="gm-hint">安全规则未改变；这些文件不能选择、查看差异或暂存。</p>
          {blockedGroups.map(reason => <section key={reason}><h3>{reason}</h3><ul className="gm-list gm-files" aria-label={reason}>{protectedFiles.filter(entry => blockedReason(entry.blocked) === reason).map(entry => <li key={entry.path}>
            <input type="checkbox" disabled aria-label={`选择 ${entry.path}`} checked={false} readOnly /><code>{entry.index}{entry.working}</code>
            <button className="gm-path" disabled title={`${entry.path} · ${reason}`}>{entry.path}</button><button disabled>{page === 'staged' ? '取消暂存' : '暂存'}</button>
          </li>)}</ul></section>)}
        </details>}
      </>}
      {page === 'branches' && <>
        <div className="gm-toolbar"><label>新分支名 <input value={name} onChange={e => setName(e.target.value)} /></label>
          <button disabled={!name.trim() || !status?.head} onClick={() => void execute({ operation: 'branchCreate', name }, true)}>从 HEAD 创建</button></div>
        <label className="gm-field">重命名目标<input value={newName} onChange={e => setNewName(e.target.value)} /></label>
        <ul className="gm-list">{branches.map(branch => <li key={branch.name}><strong className="gm-path">{branch.name}{branch.current ? ' · 当前' : ''}</strong>
          <button disabled={branch.current} onClick={() => ask({ operation: 'branchSwitch', name: branch.name }, `切换到 ${branch.name}？存在任何工作区、暂存或未跟踪改动时都会阻止切换。`)}>切换</button>
          <button disabled={!newName.trim()} onClick={() => ask({ operation: 'branchRename', name: branch.name, newName }, `将 ${branch.name} 重命名为 ${newName}？`)}>重命名</button>
          <button disabled={branch.current} onClick={() => ask({ operation: 'branchDelete', name: branch.name }, `安全删除 ${branch.name}？只允许删除已合入 HEAD 的非当前分支，不支持强制删除。`)}>安全删除</button>
        </li>)}</ul>{!branches.length && <p>暂无本地分支。</p>}
      </>}
      {page === 'history' && <>
        <ul className="gm-list">{commits.map(commit => <li key={commit.oid}><button className="gm-commit" onClick={() => void execute({ operation: 'commitDiff', ref: commit.oid })}>
          <code>{commit.oid.slice(0, 10)}</code> {commit.subject}<small>{commit.author} · {commit.date}</small></button></li>)}</ul>
        {!commits.length && <p>暂无提交。</p>}
        <div className="gm-toolbar"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><span>{commits.length ? `${offset + 1}–${offset + commits.length}` : '0 条提交'}</span><button disabled={!hasMore} onClick={() => setOffset(offset + 30)}>下一页</button></div>
      </>}
      {page === 'blame' && <><label className="gm-field">仓库相对文件路径<input value={blamePath} onChange={e => setBlamePath(e.target.value)} placeholder="src/example.ts" /></label>
        <button disabled={!blamePath.trim() || !status?.head} onClick={() => void execute({ operation: 'blame', path: blamePath })}>查看 HEAD 行归属</button><p className="gm-hint">仅显示已提交内容，不包含工作区修改。</p></>}
      {page === 'stash' && <>
        <label className="gm-field">Stash 说明<input maxLength={1000} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <label><input type="checkbox" checked={includeUntracked} onChange={e => setIncludeUntracked(e.target.checked)} /> 包含未跟踪文件（不包含忽略文件）</label>
        <button disabled={!status?.head} onClick={() => ask({ operation: 'stashCreate', message, includeUntracked }, '保存仓库改动为 stash，并从工作区移除这些改动。是否继续？')}>创建 Stash</button>
        <ul className="gm-list">{stashes.map(stash => <li key={stash.ref}><button className="gm-path" onClick={() => void execute(stashArgs('stashShow', stash))}>{stash.ref} · {stash.subject}</button>
          <button onClick={() => ask(stashArgs('stashApply', stash), `应用 ${stash.ref}，保留 stash；需要干净工作区。如发生冲突，请手动解决。`)}>Apply</button>
          <button onClick={() => ask(stashArgs('stashPop', stash), `应用并在成功后删除 ${stash.ref}？冲突时保留 stash，请手动解决。`)}>Pop</button>
          <button onClick={() => ask(stashArgs('stashDrop', stash), `永久删除 ${stash.ref}？这不会恢复其中的改动。`)}>Drop</button>
        </li>)}</ul>{!stashes.length && <p>暂无 stash。</p>}
      </>}
    </fieldset>
    {detail && !detailPath && <section className="gm-detail" aria-label="Git 详情"><div className="gm-toolbar"><strong>详情</strong><button onClick={() => setDetail(undefined)}>关闭详情</button></div>
      <GitPatch detail={detail} /></section>}
    </div>
    {filePage && <fieldset className="gm-composer" disabled={busy || !!confirmation} aria-label="提交暂存区">
      <label className="gm-field">提交摘要<textarea aria-label="提交说明" required rows={2} value={message} maxLength={5000} onChange={e => setMessage(e.target.value)} placeholder="填写提交摘要（必填）" /></label>
      <div className="gm-composer-actions"><span className="gm-hint">{blockedStaged ? '暂存区包含受保护文件，不能在此提交；请使用 Git CLI 核对。' : `已暂存 ${staged.length} 个文件 · 不会自动暂存其他改动`}</span>
      <button className="gm-primary" disabled={!message.trim() || !staged.length || blockedStaged}
        onClick={() => ask({ operation: 'commit', message: message.trim() }, '提交全部已暂存内容（不是仅提交勾选项）。不会自动 add，不会跳过 hooks。仓库 hooks 是本地受信任代码，可能修改文件。')}>仅提交暂存区</button></div>
    </fieldset>}
    {confirmation && <dialog className="gm-dialog dv-state-enter" ref={dialogRef} aria-modal="true" aria-labelledby="gm-confirm-title" aria-describedby="gm-confirm-description" onCancel={event => { event.preventDefault(); setConfirmation(undefined); }} onKeyDown={event => {
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); buttons[(at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
    }}>
      <h3 id="gm-confirm-title">确认本地 Git 操作</h3><p id="gm-confirm-description">{confirmation.description}</p>
      <p className="gm-root">{status?.root ?? root}</p>
      <div className="gm-dialog-actions"><button autoFocus onClick={() => setConfirmation(undefined)}>取消</button><button className="gm-primary" onClick={() => { const args = confirmation.args; setConfirmation(undefined); void execute({ ...args, confirmed: true }, true); }}>确认执行</button></div>
    </dialog>}
  </section>;
}
export default GitManagement;
