import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementBlame, ManagementBlameLine } from '../git/local-management';
import GitCommitButton from './GitCommitButton';
import FileIcon from './FileIcon';
import FilePath from './FilePath';

/** The parent remounts this reader on refresh, project and page changes. */
export default function GitBlame({ transport, root, head }: { transport: UiTransport; root?: string; head?: string | null }) {
  const [path, setPath] = useState(''), [data, setData] = useState<ManagementBlame>();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<string>(), [previous, setPrevious] = useState<number[]>([]);
  const ticket = useRef(0);
  useEffect(() => () => { ticket.current++; }, []);
  const groups = useMemo(() => {
    const lines = new Map<string, ManagementBlameLine[]>();
    for (const line of data?.lines ?? []) { const group = lines.get(line.oid) ?? []; group.push(line); lines.set(line.oid, group); }
    return (data?.commits ?? []).map(commit => ({ commit, lines: lines.get(commit.oid) ?? [] })).sort((a, b) => b.commit.date.localeCompare(a.commit.date));
  }, [data]);
  const read = async (skip = 0, direction: 'new' | 'next' | 'previous' = 'new') => {
    const id = ++ticket.current;
    setPending(true); setError(''); setSelected(undefined);
    if (direction === 'new') { setData(undefined); setPrevious([]); }
    try {
      const value = await transport.invoke<ManagementBlame>('gitManage', { operation: 'blame', root, path: direction === 'new' ? path.trim() : data!.path, ref: direction === 'new' ? head : data!.oid, skip, limit: 100 });
      if (ticket.current !== id) return;
      if (direction === 'next') setPrevious(values => [...values, data!.skip]);
      if (direction === 'previous') setPrevious(values => values.slice(0, -1));
      setData(value);
    } catch (cause) { if (ticket.current === id) setError(String((cause as Error)?.message ?? cause)); }
    finally { if (ticket.current === id) setPending(false); }
  };
  return <div className="gm-blame">
    <form className="gm-blame-form" onSubmit={event => { event.preventDefault(); if (!pending && path.trim() && head) void read(); }}>
      <label className="gm-field">仓库相对文件路径<input value={path} onChange={event => setPath(event.target.value)} placeholder="src/example.ts" disabled={pending} /></label>
      <button disabled={pending || !path.trim() || !head}>开始追溯</button>
    </form>
    <p className="gm-hint">查看每行最后由谁、在哪次提交中修改。仅包含已提交内容，不包含工作区修改。</p>
    {error && <p className="gm-error" role="alert">{error} 请检查文件路径后重试。</p>}
    {pending && <p role="status">正在读取追溯…</p>}
    {!data && !pending && !error && <p className="gm-hint">输入文件路径后开始追溯，点击提交摘要展开对应代码行。</p>}
    {data && <>
      <div className="gm-blame-summary"><span className="gm-blame-path" title={data.path}><FileIcon path={data.path} /><FilePath path={data.path} /></span><code title={data.oid}>{data.oid.slice(0, 10)}</code></div>
      {data.totalLines > 0 ? <p className="gm-hint">第 {data.skip + 1}–{data.skip + data.lines.length} 行 / 共 {data.totalLines} 行 · 本页涉及 {groups.length} 次提交，按时间排序</p> : <p className="gm-hint">此提交中的文件为空，没有可追溯的代码行。</p>}
      <ul className="gm-list gm-history" aria-label="文件追溯" aria-busy={pending}>{groups.map(({ commit, lines }) => <li key={commit.oid}>
        <GitCommitButton commit={commit} count={lines.length} expanded={selected === commit.oid} onClick={() => setSelected(value => value === commit.oid ? undefined : commit.oid)} />
        {selected === commit.oid && <section className="gm-commit-detail gm-blame-detail" aria-label="追溯代码行">
          <div className="gm-toolbar"><strong>本页 {lines.length} 行的最后修改</strong><button onClick={() => setSelected(undefined)}>收起代码</button></div>
          <p className="gm-hint">左侧为所查版本的行号；不连续行之间用分隔线标记。</p>
          <div className="gm-blame-code">{lines.map((line, index) => <div className={`gm-blame-line${index > 0 && line.line !== lines[index - 1].line + 1 ? ' gm-blame-gap' : ''}`} key={line.line}>
            <span className="gm-blame-number" title={`所查版本第 ${line.line} 行；原提交第 ${line.originalLine} 行`}>{line.line}</span><code>{line.text || ' '}{line.truncated && <span className="gm-blame-truncated"> …（此行过长，仅显示前 4000 字符）</span>}</code>
          </div>)}</div>
        </section>}
      </li>)}</ul>
      {data.totalLines > 0 && <div className="gm-toolbar" aria-label="追溯分页"><button disabled={pending || !previous.length} onClick={() => void read(previous.at(-1)!, 'previous')}>上一页</button><span>{data.skip + 1}–{data.skip + data.lines.length} / {data.totalLines} 行</span><button disabled={pending || !data.hasMore} onClick={() => void read(data.skip + data.lines.length, 'next')}>下一页</button></div>}
    </>}
  </div>;
}
