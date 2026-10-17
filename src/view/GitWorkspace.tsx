import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, UiTransport } from '../core/contracts';
import { GitManagement } from './GitManagement';

/** One retained workspace per session; a late result can only update its own instance. */
export function GitWorkspace({ transport, sessionId, active, base }: { transport: UiTransport; sessionId?: string; active: boolean; base?: 'light' | 'dark' }) {
  const [enabled, setEnabled] = useState(active), [retry, setRetry] = useState(0);
  const [boot, setBoot] = useState<Bootstrap>(), [root, setRoot] = useState('');
  const [visited, setVisited] = useState<string[]>([]), [locks, setLocks] = useState<Record<string, boolean>>({});
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const choiceVersion = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (active) setEnabled(true); }, [active]);
  useEffect(() => {
    if (!enabled) return;
    let live = true; const version = choiceVersion.current;
    setLoading(true); setError('');
    void transport.invoke<Bootstrap>('bootstrap', { sessionId }).then(value => {
      if (!live) return;
      setBoot(value);
      if (version === choiceVersion.current) setRoot(previous => previous || value.selectedRepository || value.repositories.find(repo => repo.git)?.root || '');
    }).catch(cause => { if (live) setError(String(cause.message ?? cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [enabled, retry, transport, sessionId]);
  const repositories = boot?.repositories.filter(repo => repo.git) ?? [];
  const available = repositories.some(repo => repo.root === root);
  const locked = Object.values(locks).some(Boolean);
  useEffect(() => {
    if (!root || !available) return;
    setVisited(previous => [root, ...previous.filter(value => value !== root)].slice(0, 6));
  }, [root, available]);
  const choose = (value: string) => {
    if (locked || !repositories.some(repo => repo.root === value)) return;
    const version = ++choiceVersion.current; setRoot(value); setError('');
    void transport.invoke('selectRepository', { sessionId, root: value, workspaceKey: boot?.workspaceKey }).catch(cause => {
      if (alive.current && version === choiceVersion.current) setError(`仓库选择未保存：${String(cause.message ?? cause)}。请重新选择以重试。`);
    });
  };
  return <section className="dv-git-workspace">
    <div className="dv-toolbar dv-git-repositories">
      <label>仓库 <select aria-label="Git 项目" title={root} value={available ? root : ''} disabled={locked || loading} onChange={event => choose(event.target.value)}>
        {!available && <option value="" disabled>{root ? '已选仓库不可用，请选择' : '请选择仓库'}</option>}
        {repositories.map(repo => <option key={repo.root} value={repo.root}>{repo.name} — {repo.root}</option>)}
      </select></label>
      <button disabled={locked || loading} onClick={() => setRetry(value => value + 1)}>重新扫描仓库</button>
    </div>
    {loading && <p className="dv-panel-message" role="status">正在扫描 Git 仓库…</p>}
    {error && <p className="dv-panel-message" role="alert">{error}</p>}
    {boot?.repositoryNotice && <p className="dv-panel-message" role="status">{boot.repositoryNotice}</p>}
    {boot && !available && <p className="dv-panel-message" role="status">{root ? `已选仓库不在当前扫描列表中：${root}。不会自动切换到其他仓库。` : '授权目录中未发现 Git 仓库，可调整工作区目录后重新扫描。'}</p>}
    {visited.map(value => <div key={value} className="dv-panel-page" hidden={!active || value !== root || !available}>
      <GitManagement transport={transport} root={value} active={active && value === root && available && !loading} base={base} onLockChange={locked => setLocks(previous => previous[value] === locked ? previous : { ...previous, [value]: locked })} />
    </div>)}
  </section>;
}
