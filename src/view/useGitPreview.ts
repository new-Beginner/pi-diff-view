import { useEffect, useRef, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementText } from '../git/local-management';

interface Preview { path?: string; data?: ManagementText; pending?: boolean; slow?: boolean; error?: string; }
/** Read-only preview has its own request identity; it never locks the mutation controls. */
export function useGitPreview(transport: UiTransport, root: string | undefined, scope: 'workspace' | 'staged', commit?: string) {
  const [preview, setPreview] = useState<Preview>({});
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const current = useRef<Preview>({}), epoch = useRef(0), ticket = useRef(0), batch = useRef(0);
  const cache = useRef(new Map<string, ManagementText>());
  const pending = useRef(new Map<string, Promise<ManagementText>>());
  const hover = useRef<ReturnType<typeof setTimeout>>();
  const multi = useRef(false), expanded = useRef(new Set<string>()), queue = useRef<string[]>([]), workers = useRef(0);
  const pumpRef = useRef<() => void>(() => {});
  const cancelPrefetch = () => { clearTimeout(hover.current); };
  const publish = (value: Preview) => { current.current = value; setPreview(value); setPreviews(value.path ? { [value.path]: value } : {}); };
  const updateMany = (path: string, value?: Preview) => setPreviews(previous => {
    const next = { ...previous };
    if (value) next[path] = value; else delete next[path];
    return next;
  });
  const invalidate = () => {
    epoch.current++; ticket.current++; batch.current++; cancelPrefetch(); cache.current.clear(); pending.current.clear(); multi.current = false; expanded.current.clear(); queue.current = []; publish({});
  };
  useEffect(() => { invalidate(); return () => { epoch.current++; ticket.current++; batch.current++; cancelPrefetch(); multi.current = false; expanded.current.clear(); queue.current = []; }; }, [root, scope, transport, commit]);
  const load = (path: string): Promise<ManagementText> => {
    const cached = cache.current.get(path);
    if (cached) return Promise.resolve(cached);
    const inFlight = pending.current.get(path);
    if (inFlight) return inFlight;
    const version = epoch.current;
    const promise = transport.invoke<ManagementText>('gitManage', commit ? { operation: 'commitDiff', root, ref: commit, path } : { operation: 'diff', root, scope, paths: [path] }).then(value => {
      if (version === epoch.current) {
        cache.current.set(path, value);
        if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!);
      }
      return value;
    }).finally(() => { if (pending.current.get(path) === promise) pending.current.delete(path); pumpRef.current(); });
    pending.current.set(path, promise);
    return promise;
  };
  const pump = () => {
    while (multi.current && workers.current < 3 && pending.current.size < 3 && queue.current.length) {
      const path = queue.current.shift()!;
      if (!expanded.current.has(path)) continue;
      workers.current++;
      const id = batch.current;
      void load(path).then(data => {
        if (id === batch.current && multi.current && expanded.current.has(path)) updateMany(path, { path, data });
      }).catch(cause => {
        if (id === batch.current && multi.current && expanded.current.has(path)) updateMany(path, { path, error: String(cause?.message ?? cause) });
      }).finally(() => { workers.current--; pumpRef.current(); });
    }
  };
  pumpRef.current = pump;
  const collapse = () => { ticket.current++; batch.current++; multi.current = false; expanded.current.clear(); queue.current = []; publish({}); };
  const toggle = (path: string) => {
    cancelPrefetch();
    if (multi.current) {
      if (expanded.current.has(path)) { expanded.current.delete(path); queue.current = queue.current.filter(item => item !== path); updateMany(path); }
      else {
        expanded.current.add(path);
        const cached = cache.current.get(path);
        updateMany(path, cached ? { path, data: cached } : { path, pending: true });
        if (!cached) { queue.current.push(path); pump(); }
      }
      return;
    }
    if (current.current.path === path) { collapse(); return; }
    const cached = cache.current.get(path), id = ++ticket.current, version = epoch.current;
    if (cached) { publish({ path, data: cached }); return; }
    publish({ path, pending: true });
    const timer = setTimeout(() => { if (id === ticket.current && version === epoch.current) publish({ path, pending: true, slow: true }); }, 180);
    void load(path).then(data => {
      if (id === ticket.current && version === epoch.current) publish({ path, data });
    }).catch(cause => {
      if (id === ticket.current && version === epoch.current) publish({ path, error: String(cause?.message ?? cause) });
    }).finally(() => clearTimeout(timer));
  };
  const expandAll = (paths: string[]) => {
    cancelPrefetch(); ticket.current++; batch.current++; multi.current = true; expanded.current = new Set(paths); queue.current = [];
    const next: Record<string, Preview> = {};
    for (const path of paths) {
      const cached = cache.current.get(path);
      next[path] = cached ? { path, data: cached } : { path, pending: true };
      if (!cached) queue.current.push(path);
    }
    current.current = {}; setPreview({}); setPreviews(next); pump();
  };
  const retry = (path: string) => {
    if (multi.current) { expanded.current.delete(path); queue.current = queue.current.filter(item => item !== path); expanded.current.add(path); updateMany(path, { path, pending: true }); queue.current.push(path); pump(); }
    else { collapse(); toggle(path); }
  };
  const prefetch = (path: string) => {
    cancelPrefetch();
    if (cache.current.has(path) || pending.current.has(path) || pending.current.size >= 2) return;
    hover.current = setTimeout(() => { void load(path).catch(() => undefined); }, 120);
  };
  return { preview, previews, toggle, retry, expandAll, collapse, invalidate, prefetch, cancelPrefetch };
}
