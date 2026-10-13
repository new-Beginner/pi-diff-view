import fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureIdentity, FileSnapshot } from '../core/contracts';
import { isImagePath } from '../core/review-file-policy';
import { assertPublicPath, canonical, digest, inside, readCapturedSnapshot, resolveCapturePath, safeResolve } from '../core/path-policy';
import { atomicJson, SnapshotStore } from '../core/storage';
import { checkScratchAncestry } from '../core/capture-context';

export interface CapturedPath { capture: CaptureIdentity; before: FileSnapshot; }
export interface WorkspaceSnapshot { paths: CapturedPath[]; complete: boolean; notice: string; }
export const WORKSPACE_NOTICE = 'Workspace capture: at most 256 files, 4096 directory entries, 16 MiB text and 3 seconds per snapshot; credentials, private paths, dependencies and symlinks excluded. Only observed endpoints are retained; transient changes and uninstrumented/background writers cannot be proven. Renames are represented as deletion/addition.';
/** No Git, command interpretation, symlink traversal, or external-directory discovery. */
export async function snapshotWorkspace(root: string, privatePaths: string[]): Promise<WorkspaceSnapshot> {
  const result: WorkspaceSnapshot = { paths: [], complete: true, notice: WORKSPACE_NOTICE };
  const deadline = Date.now() + 3000;
  let entries = 0, bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    if (Date.now() > deadline || entries >= 4096 || result.paths.length >= 256) { result.complete = false; return; }
    let dir: Dir | undefined;
    const directories: string[] = [];
    try {
      if (directory !== root) await safeResolve(root, directory);
      if (privatePaths.some(p => inside(p, directory))) return;
      dir = await fs.opendir(directory);
      for await (const entry of dir) {
        if (++entries > 4096 || Date.now() > deadline || result.paths.length >= 256) { result.complete = false; break; }
        const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
        try {
          try { assertPublicPath(relative); } catch { continue; }
          if (privatePaths.some(p => inside(p, absolute)) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) directories.push(absolute);
          else if (entry.isFile() && !isImagePath(relative)) {
            const capture = await resolveCapturePath(root, relative, privatePaths);
            let before = await readCapturedSnapshot(root, capture, privatePaths);
            if (before.text !== null) {
              bytes += before.size;
              if (bytes > 16 * 1024 * 1024) { before = { ...before, kind: 'unavailable', text: null }; result.complete = false; }
            }
            result.paths.push({ capture, before });
          } else if (entry.isFile()) continue;
          else result.complete = false;
        } catch { result.complete = false; }
      }
      // Capture top-level manifests/lockfiles before spending the bounded scan on descendants.
      for (const child of directories) await walk(child);
    } catch { result.complete = false; }
    finally { await dir?.close().catch(() => {}); }
  };
  // Validate the root itself before opening any descendants.
  try { assertPublicPath(root); await checkScratchAncestry(root); await walk(root); } catch { result.complete = false; }
  return result;
}

export interface Lease { id: string; root: string; scopes?: string[]; owner: string; ambiguous: boolean; sessionId?: string; toolCallId?: string; executionId?: string; }
interface Journal { version: 1; leases: Lease[]; }
/** Persistent across runners/processes. No nested captureLock/writeRun calls. */
async function journal<T>(store: SnapshotStore, work: (journal: Journal) => T): Promise<T> {
  return store.captureLock(async () => {
    const file = path.join(store.directory, 'capture-leases.json');
    let data: Journal;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 1024 * 1024) throw new Error('Capture lease journal exceeds limit');
      data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.leases) || data.leases.some(l => typeof l.id !== 'string' || typeof l.root !== 'string' || typeof l.ambiguous !== 'boolean')) throw new Error('Invalid capture lease journal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      data = { version: 1, leases: [] };
    }
    const result = work(data);
    await atomicJson(file, data);
    return result;
  });
}
export async function beginCaptureLease(store: SnapshotStore, root: string, owner: string, scopes: string[] = [], lifecycle: Pick<Lease, 'sessionId' | 'toolCallId' | 'executionId'> = {}): Promise<string> {
  return journal(store, data => {
    // Never expire uncertain leases by elapsed time: a slow/background tool may still write.
    if (data.leases.length >= 256) throw new Error('Capture lease limit reached; inspect unresolved leases and verify writers stopped before retiring exact legacy IDs');
    const lease: Lease = { id: randomUUID(), root, scopes: scopes.length ? [...new Set(scopes)] : [root], owner, ambiguous: false, ...lifecycle };
    for (const other of data.leases) if ((other.scopes ?? [other.root]).some(a => lease.scopes!.some(b => inside(a, b) || inside(b, a)))) other.ambiguous = lease.ambiguous = true;
    data.leases.push(lease);
    return lease.id;
  });
}
export async function endCaptureLease(store: SnapshotStore, id: string): Promise<boolean> {
  return journal(store, data => {
    const lease = data.leases.find(l => l.id === id);
    data.leases = data.leases.filter(l => l.id !== id);
    return !lease || lease.ambiguous;
  });
}

export async function inspectCaptureLeases(store: SnapshotStore): Promise<{ fingerprint: string; leases: Lease[] }> {
  const file = path.join(store.directory, 'capture-leases.json');
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return { fingerprint: digest('absent'), leases: [] };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe lease journal');
  const text = await fs.readFile(file, 'utf8'), data: Journal = JSON.parse(text);
  if (data.version !== 1 || !Array.isArray(data.leases)) throw new Error('Invalid lease journal');
  return { fingerprint: digest(text), leases: data.leases };
}
/** Manual maintenance only: caller must separately confirm every legacy writer/child stopped.
 * Fresh fingerprint + exact IDs + root guard + backup; never clear the journal globally.
 */
export async function retireLegacyCaptureLeases(store: SnapshotStore, root: string, ids: string[], fingerprint: string, writersStopped: boolean): Promise<void> {
  if (!writersStopped || !ids.length || new Set(ids).size !== ids.length) throw new Error('Explicit confirmation of stopped legacy writers is required');
  await store.captureLock(async () => {
    const current = await inspectCaptureLeases(store);
    if (current.fingerprint !== fingerprint) throw new Error('Lease journal changed; inspect again');
    const selected = current.leases.filter(l => ids.includes(l.id));
    if (selected.length !== ids.length || selected.some(l => canonical(l.root) !== canonical(root) || l.sessionId || l.toolCallId)) throw new Error('Unverified or non-legacy lease selection');
    await atomicJson(path.join(store.directory, 'backups', `leases-${fingerprint}.json`), { version: 1, leases: current.leases });
    await atomicJson(path.join(store.directory, 'capture-leases.json'), { version: 1, leases: current.leases.filter(l => !ids.includes(l.id)) });
  });
}
