import type { ManagementText } from '../git/local-management';

/** Display Git's bounded plain text without interpreting HTML or changing the patch. */
export default function GitPatch({ detail }: { detail: ManagementText }) {
  let inHunk = false;
  const lines = (detail.text || '没有文本差异。').split('\n').map((line, index) => {
    if (line.startsWith('diff ') || line.startsWith('Index:')) inHunk = false;
    const heading = /^@@ /.test(line);
    if (heading) inHunk = true;
    const kind = heading ? 'hunk' : inHunk && line.startsWith('+') ? 'add' : inHunk && line.startsWith('-') ? 'del' : 'context';
    return <span key={index} className={`gm-patch-line gm-patch-${kind}`}>{line || ' '}{'\n'}</span>;
  });
  return <>{detail.notice && <p className="gm-hint">{detail.notice}</p>}{detail.truncated && <p role="status">内容过长，仅显示前段；请使用 Git CLI 查看完整内容。</p>}
    <pre className="gm-patch" tabIndex={0}>{lines}</pre></>;
}
