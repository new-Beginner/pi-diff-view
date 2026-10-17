import type { ManagementCommit } from '../git/local-management';

/** Shared two-line timeline entry for history and line attribution. */
export default function GitCommitButton({ commit, expanded, onClick, count }: { commit: ManagementCommit; expanded: boolean; onClick: () => void; count?: number }) {
  return <button className="gm-commit" title={commit.subject} aria-pressed={expanded} aria-expanded={expanded} onClick={onClick}>
    <span className="gm-commit-main"><span className="gm-commit-subject">{commit.subject || '（无提交摘要）'}</span><span className="gm-commit-badges">{count !== undefined && <span className="gm-blame-count">{count} 行</span>}<code title={commit.oid}>{commit.oid.slice(0, 10)}</code></span></span>
    <span className="gm-commit-meta"><span title={commit.author}>{commit.author}</span><time dateTime={commit.date} title={commit.date}>{new Date(commit.date).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></span>
  </button>;
}
