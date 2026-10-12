import { useEffect, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementStat, ManagementStatus } from '../git/local-management';

/** Stats are batched independently of file opening and never disable the UI. */
export function useGitStats(transport: UiTransport, root: string | undefined, scope: 'workspace' | 'staged', status?: ManagementStatus) {
  const [snapshot, setSnapshot] = useState<{ status?: ManagementStatus; scope?: string; values: Map<string, ManagementStat> }>({ values: new Map() });
  useEffect(() => {
    let live = true;
    if (!status) return;
    const paths = status.entries.filter(entry => !entry.blocked && (scope === 'staged' ? ![' ', '?'].includes(entry.index) : entry.working !== ' ')).map(entry => entry.path);
    setSnapshot({ status, scope, values: new Map() });
    void (async () => {
      for (let start = 0; start < paths.length && live; start += 80) {
        const batch = paths.slice(start, start + 80);
        let entries: ManagementStat[];
        try { entries = (await transport.invoke<{ entries: ManagementStat[] }>('gitManage', { operation: 'stats', root, scope, paths: batch })).entries; }
        catch { entries = batch.map(path => ({ path, additions: null, deletions: null, kind: 'unknown' })); }
        if (!live) return;
        setSnapshot(previous => {
          if (previous.status !== status || previous.scope !== scope) return previous;
          const values = new Map(previous.values);
          for (const entry of entries) values.set(entry.path, entry);
          return { status, scope, values };
        });
      }
    })();
    return () => { live = false; };
  }, [transport, root, scope, status]);
  return snapshot.status === status && snapshot.scope === scope ? snapshot.values : new Map<string, ManagementStat>();
}
