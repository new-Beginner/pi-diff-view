import { useEffect, useRef, useState } from 'react';
import type { UiTransport } from '../core/contracts';
import type { ManagementText } from '../git/local-management';

interface Preview { path?: string; data?: ManagementText; pending?: boolean; slow?: boolean; error?: string; }
/** Read-only preview has its own request identity; it never locks the mutation controls. */
export function useGitPreview(transport: UiTransport, root: string | undefined, scope: 'workspace' | 'staged') {
  const [preview, setPreview] = useState<Preview>({});
  const current = useRef<Preview>({}), epoch = useRef(0), ticket = useRef(0);
  const cache = useRef(new Map<string, ManagementText>());
  const pending = useRef(new Map<string, Promise<ManagementText>>());
  const hover = useRef<ReturnType<typeof setTimeout>>();
  const cancelPrefetch = () => { clearTimeout(hover.current); };
  const publish = (value: Preview) => { current.current = value; setPreview(value); };
  const invalidate = () => {
    epoch.current++; ticket.current++; cancelPrefetch(); cache.current.clear(); pending.current.clear(); publish({});
  };
  useEffect(() => { invalidate(); return () => { epoch.current++; ticket.current++; cancelPrefetch(); }; }, [root, scope, transport]);
  const load = (path: string): Promise<ManagementText> => {
    const cached = cache.current.get(path);
    if (cached) return Promise.resolve(cached);
    const inFlight = pending.current.get(path);
    if (inFlight) return inFlight;
    const version = epoch.current;
    const promise = transport.invoke<ManagementText>('gitManage', { operation: 'diff', root, scope, paths: [path] }).then(value => {
      if (version === epoch.current) {
        cache.current.set(path, value);
        if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!);
      }
      return value;
    }).finally(() => { if (pending.current.get(path) === promise) pending.current.delete(path); });
    pending.current.set(path, promise);
    return promise;
  };
  const collapse = () => { ticket.current++; publish({}); };
  const toggle = (path: string) => {
    cancelPrefetch();
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
  const prefetch = (path: string) => {
    cancelPrefetch();
    if (cache.current.has(path) || pending.current.has(path) || pending.current.size >= 2) return;
    hover.current = setTimeout(() => { void load(path).catch(() => undefined); }, 120);
  };
  return { preview, toggle, collapse, invalidate, prefetch, cancelPrefetch };
}
