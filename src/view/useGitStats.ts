import { useEffect, useRef, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementStat, ManagementStatus } from '../git/local-management';

type Scope = 'workspace' | 'staged';
interface CachedStat { value: ManagementStat; status: ManagementStatus; }
function context(transport: UiTransport, root?: string) {
  return { transport, root, values: new Map<Scope, Map<string, CachedStat>>(), requests: new WeakMap<ManagementStatus, Map<string, Promise<ManagementStat[]>>>() };
}
/** Retain scoped values while revalidating; never treat a status code as a content fingerprint. */
export function useGitStats(transport: UiTransport, root: string | undefined, scope: Scope, status?: ManagementStatus, enabled = true) {
  const cache = useRef(context(transport, root));
  if (cache.current.transport !== transport || cache.current.root !== root) cache.current = context(transport, root);
  const current = cache.current;
  const [, redraw] = useState(0);
  const visible = (status?.entries ?? []).filter(entry => !entry.blocked && (scope === 'staged' ? ![' ', '?'].includes(entry.index) : entry.working !== ' '));
  useEffect(() => {
    if (!status || !enabled) return;
    let live = true;
    const values = current.values.get(scope) ?? new Map<string, CachedStat>();
    current.values.set(scope, values);
    const paths = new Set(visible.map(entry => entry.path));
    for (const path of values.keys()) if (!paths.has(path)) values.delete(path);
    const missing: string[] = [];
    for (const entry of visible) {
      if (scope === 'workspace' && entry.stats) values.set(entry.path, { value: entry.stats, status });
      else if (values.get(entry.path)?.status !== status) missing.push(entry.path);
    }
    const requests = current.requests.get(status) ?? new Map<string, Promise<ManagementStat[]>>();
    current.requests.set(status, requests);
    void (async () => {
      for (let start = 0; start < missing.length && live; start += 80) {
        const batch = missing.slice(start, start + 80), key = JSON.stringify([scope, batch]);
        let task = requests.get(key);
        if (!task) {
          task = transport.invoke<{ entries: ManagementStat[] }>('gitManage', { operation: 'stats', root, scope, paths: batch })
            .then(result => result.entries).catch(() => batch.map(path => ({ path, additions: null, deletions: null, kind: 'unknown' as const })));
          requests.set(key, task);
        }
        const entries = await task;
        if (!live) return;
        const byPath = new Map(entries.map(entry => [entry.path, entry]));
        for (const path of batch) values.set(path, { value: byPath.get(path) ?? { path, additions: null, deletions: null, kind: 'unknown' }, status });
        redraw(value => value + 1);
      }
    })();
    return () => { live = false; };
  }, [current, transport, root, scope, status, enabled]);
  const values = new Map<string, ManagementStat>(), refreshing = new Set<string>();
  for (const entry of visible) {
    const cached = current.values.get(scope)?.get(entry.path);
    const inline = scope === 'workspace' ? entry.stats : undefined;
    const value = inline ?? cached?.value;
    if (value) values.set(entry.path, value);
    if (!enabled || (!inline && cached?.status !== status)) refreshing.add(entry.path);
  }
  return { values, refreshing };
}
