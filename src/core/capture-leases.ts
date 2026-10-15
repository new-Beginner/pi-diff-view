import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureIdentity, FileSnapshot } from './contracts';
import { assertPublicPath, canonical, digest, inside } from './path-policy';
import { atomicJson, type SnapshotStore } from './storage';

export interface PreparedPath { capture: CaptureIdentity; before: FileSnapshot; }
export interface Preparation { name: string; userMessageId?: string; paths: PreparedPath[]; }
export interface Lease { id: string; root: string; scopes?: string[]; owner: string; ambiguous: boolean; closed?: boolean; sessionId?: string; toolCallId?: string; executionId?: string; prepared?: Preparation; }
interface Journal { version: 1; leases: Lease[]; }
const MAX_JOURNAL_BYTES = 1024 * 1024;
function validate(data: Journal): void {
  if (data.version !== 1 || !Array.isArray(data.leases) || data.leases.length > 256 || new Set(data.leases.map(l => l.id)).size !== data.leases.length) throw new Error('Invalid capture lease journal');
  for (const l of data.leases) {
    if (typeof l.id !== 'string' || typeof l.root !== 'string' || typeof l.ambiguous !== 'boolean' || (l.closed !== undefined && typeof l.closed !== 'boolean')) throw new Error('Invalid capture lease');
    const p = l.prepared;
    if (!p) continue; // Legacy metadata remains conservative and is never promoted to preparation.
    if (![l.owner, l.sessionId, l.executionId].every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)) || typeof l.toolCallId !== 'string' || !l.toolCallId.length || l.toolCallId.length > 256 || !path.isAbsolute(l.root) || typeof p.name !== 'string' || p.name.length > 100 || (p.userMessageId !== undefined && (typeof p.userMessageId !== 'string' || p.userMessageId.length > 256)) || !Array.isArray(p.paths) || p.paths.length > 256) throw new Error('Invalid preparation identity');
    for (const { capture: c, before: s } of p.paths) {
      if (!c || !s || typeof c.absolutePath !== 'string' || !path.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) throw new Error('Invalid preparation path');
      assertPublicPath(c.path); assertPublicPath(c.absolutePath);
      if (c.origin === 'workspace' ? path.isAbsolute(c.path) || !inside(l.root, c.absolutePath) || canonical(path.resolve(l.root, c.path)) !== c.identity : c.origin !== 'external' || inside(l.root, c.absolutePath) || canonical(c.path) !== c.identity) throw new Error('Invalid preparation scope');
      if (!(l.scopes ?? []).some(scope => canonical(scope) === c.identity) || s.text !== null || typeof s.exists !== 'boolean' || typeof s.hash !== 'string' || !Number.isFinite(s.size) || s.size < 0 || !Number.isFinite(s.mode) || !['text', 'binary', 'large', 'symlink', 'submodule', 'conflict', 'unavailable'].includes(s.kind)) throw new Error('Invalid preparation endpoint');
      if (s.kind === 'text' && (s.exists ? !/^[a-f0-9]{64}$/.test(s.hash) || s.size > 2 * 1024 * 1024 : s.hash !== 'absent' || s.size !== 0)) throw new Error('Invalid preparation text');
    }
  }
}
export async function inspectCaptureLeases(store: SnapshotStore): Promise<{ fingerprint: string; leases: Lease[] }> {
  const file = path.join(store.directory, 'capture-leases.json');
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return { fingerprint: digest('absent'), leases: [] };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) throw new Error('Unsafe lease journal');
  const text = await fs.readFile(file, 'utf8'), data: Journal = JSON.parse(text);
  validate(data);
  return { fingerprint: digest(text), leases: data.leases };
}
/** Caller holds captureLock; bounded metadata only, never full snapshot text. */
export async function writeCaptureLeases(store: SnapshotStore, leases: Lease[]): Promise<void> {
  const data: Journal = { version: 1, leases }; validate(data);
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_JOURNAL_BYTES) throw new Error('Capture lease journal exceeds limit');
  await atomicJson(path.join(store.directory, 'capture-leases.json'), data);
}
async function journal<T>(store: SnapshotStore, work: (leases: Lease[]) => T): Promise<T> {
  return store.captureLock(async () => {
    const { leases } = await inspectCaptureLeases(store);
    const result = work(leases);
    await writeCaptureLeases(store, leases);
    return result;
  });
}
export async function beginCaptureLease(store: SnapshotStore, root: string, owner: string, scopes: string[] = [], lifecycle: Pick<Lease, 'sessionId' | 'toolCallId' | 'executionId'> = {}): Promise<string> {
  return journal(store, leases => {
    // Never expire uncertain leases by elapsed time: background tools may still write.
    if (leases.length >= 256) throw new Error('Capture lease limit reached; verify unresolved writers before retiring leases');
    const lease: Lease = { id: randomUUID(), root, scopes: scopes.length ? [...new Set(scopes)] : [root], owner, ambiguous: false, ...lifecycle };
    for (const other of leases) if (!other.closed && (other.scopes ?? [other.root]).some(a => lease.scopes!.some(b => inside(a, b) || inside(b, a)))) other.ambiguous = lease.ambiguous = true;
    leases.push(lease); return lease.id;
  });
}
/** Blob content is saved before publishing references; returning allows the mutation to proceed. */
export async function prepareCaptureLease(store: SnapshotStore, id: string, preparation: Preparation): Promise<void> {
  await store.captureLock(async () => {
    const { leases } = await inspectCaptureLeases(store), lease = leases.find(l => l.id === id);
    if (!lease || lease.prepared) throw new Error('Missing or already prepared capture lease');
    const paths: PreparedPath[] = [];
    for (const entry of preparation.paths) paths.push({ capture: entry.capture, before: await store.saveBlob(entry.before) });
    lease.prepared = { ...preparation, paths };
    await writeCaptureLeases(store, leases);
  });
}
/** Close the write interval, retaining preparation until result persistence succeeds. */
export async function closeCaptureLease(store: SnapshotStore, id: string): Promise<boolean> {
  return journal(store, leases => {
    const lease = leases.find(l => l.id === id);
    if (lease) lease.closed = true;
    return !lease || lease.ambiguous;
  });
}
export async function endCaptureLease(store: SnapshotStore, id: string): Promise<boolean> {
  return journal(store, leases => {
    const index = leases.findIndex(l => l.id === id), lease = leases[index];
    if (index >= 0) leases.splice(index, 1);
    return !lease || lease.ambiguous;
  });
}
/** Manual maintenance only: fresh fingerprint, exact legacy IDs, verified stopped writers. */
export async function retireLegacyCaptureLeases(store: SnapshotStore, root: string, ids: string[], fingerprint: string, writersStopped: boolean): Promise<void> {
  if (!writersStopped || !ids.length || new Set(ids).size !== ids.length) throw new Error('Explicit confirmation of stopped legacy writers is required');
  await store.captureLock(async () => {
    const current = await inspectCaptureLeases(store);
    if (current.fingerprint !== fingerprint) throw new Error('Lease journal changed; inspect again');
    const selected = current.leases.filter(l => ids.includes(l.id));
    if (selected.length !== ids.length || selected.some(l => canonical(l.root) !== canonical(root) || l.sessionId || l.toolCallId)) throw new Error('Unverified or non-legacy lease selection');
    await atomicJson(path.join(store.directory, 'backups', `leases-${fingerprint}.json`), { version: 1, leases: current.leases });
    await writeCaptureLeases(store, current.leases.filter(l => !ids.includes(l.id)));
  });
}
