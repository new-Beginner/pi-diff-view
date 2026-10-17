import { useEffect, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementCommit, ManagementCommitFiles } from '../git/local-management';
import FileIcon from './FileIcon';
import FilePath from './FilePath';
import ReviewIcon from './ReviewIcon';
import GitPatch from './GitPatch';
import { useGitPreview } from './useGitPreview';
import GitCommitButton from './GitCommitButton';

const statuses: Record<string, string> = { A: '新增', M: '修改', D: '删除', T: '类型变更' };
type Source = { transport: UiTransport; root?: string };
function CommitDetails({ transport, root, commit, close }: Source & { commit: ManagementCommit; close: () => void }) {
  const [files, setFiles] = useState<ManagementCommitFiles>();
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const preview = useGitPreview(transport, root, 'workspace', commit.oid);
  useEffect(() => {
    let cancelled = false;
    setFiles(undefined); setError('');
    void transport.invoke<ManagementCommitFiles>('gitManage', { operation: 'commitFiles', root, ref: commit.oid })
      .then(value => { if (!cancelled) setFiles(value); })
      .catch(cause => { if (!cancelled) setError(String(cause?.message ?? cause)); });
    return () => { cancelled = true; };
  }, [transport, root, commit.oid, retry]);
  return <section className="gm-commit-detail" aria-label="Git 详情" aria-busy={!files && !error}>
    <div className="gm-toolbar"><strong>提交改动{files ? ` · ${files.entries.length} 个文件` : ''}</strong>
      <button className="gm-icon-button" aria-label="折叠全部文件" title="折叠全部文件" disabled={!preview.preview.path} onClick={preview.collapse}><ReviewIcon name="collapse" /></button>
      <button className="gm-icon-button" aria-label="关闭详情" title="关闭详情" onClick={close}><ReviewIcon name="close" /></button>
    </div>
    <p className="gm-hint gm-commit-identity"><code title={commit.oid}>{commit.oid}</code></p>
    {files && <p className="gm-hint">{files.parent ? `与第一父提交 ${files.parent.slice(0, 10)} 比较` : '首次提交，与空树比较'}；仅显示已提交改动。</p>}
    {!files && !error && <p role="status">正在读取提交文件…</p>}
    {error && <p className="gm-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {files && <ul className="gm-list gm-files" aria-label="提交文件">{files.entries.map(entry => <li key={entry.path}>
      <div className="gm-file-row">
        <span className="gm-history-status" title={statuses[entry.status] ?? entry.status}>{entry.status}</span>
        <button className="gm-path gm-file" aria-label={entry.path} disabled={!!entry.blocked} aria-expanded={preview.preview.path === entry.path}
          title={entry.blocked ? `${entry.path} · ${entry.blocked}` : entry.path}
          onClick={() => preview.toggle(entry.path)} onPointerEnter={() => { if (!entry.blocked) preview.prefetch(entry.path); }} onPointerLeave={preview.cancelPrefetch}
          onFocus={() => { if (!entry.blocked) preview.prefetch(entry.path); }} onBlur={preview.cancelPrefetch}>
          <FileIcon path={entry.path} /><span className="gm-file-name"><FilePath path={entry.path} /></span><span className="gm-file-chevron"><ReviewIcon name="chevron" /></span>
        </button>
        <span className="gm-file-stats" aria-label={`${entry.path} 增删行数`}>{entry.blocked ? <span className="gm-stats-unknown">受保护</span> : entry.additions != null && entry.deletions != null ? <><span className="gm-added">+{entry.additions}</span><span className="gm-deleted">-{entry.deletions}</span></> : <span className="gm-stats-unknown">{entry.kind === 'binary' ? '二进制' : '行数未知'}</span>}</span>
      </div>
      {preview.preview.path === entry.path && <section className="gm-inline-diff" aria-label={`${entry.path} 差异`} aria-busy={!!preview.preview.pending}>
        {preview.preview.data ? <GitPatch detail={preview.preview.data} /> : preview.preview.error ? <p role="alert">{preview.preview.error}<button onClick={() => { preview.collapse(); preview.toggle(entry.path); }}>重试</button></p> : <div className="gm-preview-placeholder">{preview.preview.slow && <span role="status">正在读取差异…</span>}</div>}
      </section>}
    </li>)}</ul>}
    {files && !files.entries.length && <p className="gm-hint">此提交没有文件改动。</p>}
    {files?.entries.some(entry => entry.blocked) && <p className="gm-hint">受保护路径、符号链接与子模块不提供差异预览；其他文件仍可查看。</p>}
  </section>;
}

/** Each selection mounts a separate reader; late responses cannot replace another commit. */
export default function GitHistory({ transport, root, commits }: Source & { commits: ManagementCommit[] }) {
  const [selected, setSelected] = useState<string>();
  return <ul className="gm-list gm-history" aria-label="提交历史">{commits.map(commit => <li key={commit.oid}>
    <GitCommitButton commit={commit} expanded={selected === commit.oid} onClick={() => setSelected(value => value === commit.oid ? undefined : commit.oid)} />
    {selected === commit.oid && <CommitDetails key={commit.oid} transport={transport} root={root} commit={commit} close={() => setSelected(undefined)} />}
  </li>)}</ul>;
}
