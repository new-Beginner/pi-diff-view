import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertPublicPath, canonical, digest, fail, inside, sameSnapshot } from './path-policy';
import { stats } from './diff';
import { MAX_CAPTURE_SEGMENTS, type CaptureRun, type CapturedChange, type FileSnapshot, type ReviewComment } from './contracts';
export const MAX_RUNS = 200;
export const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
/** Compare capture provenance, not derived stats or stripped blob text. */
export function captureCheckpoint(change?: CapturedChange): string {
  const snapshot = (value: FileSnapshot) => [value.exists, value.kind, value.hash, value.size, value.mode];
  return digest(JSON.stringify(change ? [change.capture, change.evidence, change.ambiguous, change.note, snapshot(change.before), snapshot(change.after), change.segments?.map(s => [s.evidence, s.ambiguous, s.conflicted, snapshot(s.before), snapshot(s.after)]), change.segmentsTruncated] : null));
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function readJson<T>(file: string, fallback?: T): Promise<T> {
  try { const s = await fs.stat(file); if (s.size > 16 * 1024 * 1024) fail('STORE_LIMIT', 'Store record too large'); return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function locatorPath(pluginRoot: string): Promise<string> { return path.join(os.homedir(), '.pi-diff-view', 'locators', `${digest(canonical(await fs.realpath(pluginRoot)))}.json`); }
export interface Locator { version: 1; pluginRoot: string; dataPath: string; generation: string; expiresAt: number; }
export async function resolveLocator(file: string, pluginRoot: string): Promise<Locator> {
  const locator = await readJson<Locator>(file);
  if (locator.version !== 1 || typeof locator.generation !== 'string' || !/^[\w-]{20,80}$/.test(locator.generation) || locator.expiresAt < Date.now() || locator.expiresAt > Date.now() + 90000 || canonical(locator.pluginRoot) !== canonical(await fs.realpath(pluginRoot))) fail('BRIDGE_UNAVAILABLE', 'Diff view capture bridge is missing or expired; reload the plugin');
  if (!path.isAbsolute(locator.dataPath)) fail('BRIDGE_INVALID', 'Invalid plugin storage path');
  const stat = await fs.lstat(locator.dataPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs.realpath(locator.dataPath)) !== canonical(locator.dataPath)) fail('BRIDGE_INVALID', 'Unsafe plugin storage root');
  return locator;
}
function validId(id: string): void { if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('INVALID_ID', 'Invalid record identifier'); }
function validRun(run: CaptureRun, id: string): boolean {
  if (!run || ![1, 2].includes(run.version) || run.id !== id || typeof run.sessionId !== 'string' || !path.isAbsolute(run.root) || !run.changes || Array.isArray(run.changes) || Object.keys(run.changes).length > 256 || !Array.isArray(run.replies) || !run.bindings) return false;
  try {
    for (const [value, change] of Object.entries(run.changes)) {
      assertPublicPath(value);
      if (change.segments !== undefined && (!Array.isArray(change.segments) || change.segments.length > MAX_CAPTURE_SEGMENTS || change.segments.some(s => !s || typeof s.evidence !== 'string' || s.evidence.length > 1024 || !s.evidence.includes(':') || (s.ambiguous !== undefined && typeof s.ambiguous !== 'boolean') || (s.conflicted !== undefined && (s.conflicted !== true || s.ambiguous !== true))))) return false;
      for (const snapshot of [change.before, change.after, ...(change.segments ?? []).flatMap(s => [s.before, s.after])]) if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.hash !== 'string' || !Number.isFinite(snapshot.size) || snapshot.size < 0 || !Number.isFinite(snapshot.mode) || !['text', 'binary', 'large', 'symlink', 'submodule', 'conflict', 'unavailable'].includes(snapshot.kind)) return false;
      if (run.version === 1) { if (path.isAbsolute(value) || !inside(run.root, path.resolve(run.root, value))) return false; }
      else {
        const c = change.capture;
        if (!c || c.path !== value || !path.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) return false;
        if (c.origin === 'workspace') { if (path.isAbsolute(value) || !inside(run.root, c.absolutePath) || canonical(path.resolve(run.root, value)) !== c.identity) return false; }
        else if (c.origin !== 'external' || inside(run.root, c.absolutePath) || canonical(value) !== c.identity) return false;
      }
    }
    return true;
  } catch { return false; }
}
export class SnapshotStore {
  private pendingRecovery = new Set<string>();
  needsRecovery(sessionId: string): boolean { return this.pendingRecovery.has(sessionId); }
  acknowledgeRecovery(sessionId: string): void { this.pendingRecovery.delete(sessionId); }
  constructor(readonly directory: string) {}
  async init(): Promise<void> { for (const sub of ['blobs', 'inbox', 'runs', 'contributions', 'backups', 'evidence']) await fs.mkdir(path.join(this.directory, sub), { recursive: true, mode: 0o700 }); }
  /** Called under captureLock after the destination has been durably written. */
  async retireRun(from: string, to: string): Promise<void> {
    validId(from); validId(to); if (from === to) return;
    const target = await this.getRun(to, false, false);
    const recorded = await this.getRun(from, false, false);
    const stableHostId = target?.userMessageId && `host-${digest(`${target.sessionId}\0${target.userMessageId}`).slice(0, 48)}`;
    const source = recorded ?? (from === stableHostId && target ? { ...target, id: from } : null);
    if (!source || !target || source.sessionId !== target.sessionId || source.userMessageId !== target.userMessageId) fail('REPAIR_IDENTITY', 'Cannot retire unverified run identity');
    const fileAliases = await readJson<Record<string, string>>(path.join(this.directory, 'file-aliases.json'), {});
    const paths = new Map<string, string>();
    for (const [value, change] of Object.entries(source.changes)) {
      const match = target.changes[value] ? value : Object.keys(target.changes).find(p => target.changes[p].capture?.identity === change.capture?.identity);
      if (!match) continue; paths.set(value, match);
      if (change.capture?.id && target.changes[match].capture?.id) fileAliases[`${from}:${change.capture.id}`] = target.changes[match].capture!.id;
    }
    await atomicJson(path.join(this.directory, 'file-aliases.json'), fileAliases);
    const comments = await this.comments();
    for (const comment of comments) if (comment.sessionId === source.sessionId && comment.anchor.runId === from && canonical(comment.anchor.root) === canonical(source.root) && paths.has(comment.anchor.path)) {
      comment.anchor = { ...comment.anchor, runId: to, root: target.root, path: paths.get(comment.anchor.path)! }; comment.stale = true;
    }
    await this.saveComments(comments);
    const aliases = await readJson<Record<string, string>>(path.join(this.directory, 'run-aliases.json'), {});
    aliases[from] = to; await atomicJson(path.join(this.directory, 'run-aliases.json'), aliases);
    if (recorded) await atomicJson(path.join(this.directory, 'contributions', `${from}.json`), { ...recorded, userMessageId: target.userMessageId });
    for (const sub of ['runs', 'inbox']) await fs.rm(path.join(this.directory, sub, `${from}.json`), { force: true });
  }
  async resolveFileId(runId: string, fileId?: string): Promise<string | undefined> {
    if (!fileId) return fileId;
    const aliases = await readJson<Record<string, string>>(path.join(this.directory, 'file-aliases.json'), {});
    return aliases[`${runId}:${fileId}`] ?? fileId;
  }
  async captureLock<T>(work: () => Promise<T>): Promise<T> {
    const lock = path.join(this.directory, 'capture.lock'); let handle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 80 && !handle; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await readJson<{ pid?: number } | null>(lock, null).catch(() => null);
        if (owner?.pid && owner.pid !== process.pid) {
          try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') await fs.rm(lock, { force: true }); }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!handle) fail('STORE_BUSY', 'Capture store is busy; retry after active Agents stop');
    try { return await work(); } finally { await handle.close(); await fs.rm(lock, { force: true }); }
  }
  async saveBlob(snapshot: FileSnapshot): Promise<FileSnapshot> {
    if (snapshot.kind === 'text' && snapshot.exists && snapshot.text !== null) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.hash) || digest(snapshot.text) !== snapshot.hash) fail('SNAPSHOT_INVALID', 'Snapshot content hash does not match');
      const file = path.join(this.directory, 'blobs', snapshot.hash);
      if (!(await fs.stat(file).catch(() => null))) {
        const lock = path.join(this.directory, 'quota.lock');
        let handle: fs.FileHandle | undefined;
        for (let attempt = 0; attempt < 40 && !handle; attempt++) {
          try { handle = await fs.open(lock, 'wx', 0o600); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const s = await fs.stat(lock).catch(() => null); if (s && Date.now() - s.mtimeMs > 60000) await fs.rm(lock, { force: true }); else await new Promise(r => setTimeout(r, 25)); }
        }
        if (!handle) fail('STORE_BUSY', 'Snapshot store is busy; capture marked incomplete');
        try {
          const entries = await fs.readdir(path.dirname(file));
          if (entries.length > 4096) fail('STORE_LIMIT', 'Snapshot limit reached; clear plugin history after stopping Agents');
          let size = 0;
          for (let offset = 0; offset < entries.length; offset += 16) {
            const batch = entries.slice(offset, offset + 16);
            const sizes = await Promise.all(batch.map(entry => fs.stat(path.join(path.dirname(file), entry)).then(stat => stat.size)));
            size += sizes.reduce((total, value) => total + value, 0);
          }
          if (size + snapshot.size > MAX_HISTORY_BYTES) fail('STORE_LIMIT', '128 MiB snapshot capacity reached; clear plugin history after stopping Agents');
          try { await fs.writeFile(file, snapshot.text, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        } finally { await handle.close(); await fs.rm(lock, { force: true }); }
      }
    }
    return { ...snapshot, text: null };
  }
  async inspect(snapshot: FileSnapshot): Promise<FileSnapshot> {
    if (!snapshot.exists || snapshot.kind !== 'text') return { ...snapshot };
    if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: 'unavailable', text: null };
    try {
      const stat = await fs.lstat(path.join(this.directory, 'blobs', snapshot.hash));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || stat.size !== snapshot.size) throw new Error('Unsafe blob');
      return { ...snapshot, text: null };
    } catch { return { ...snapshot, kind: 'unavailable', text: null }; }
  }
  async hydrate(snapshot: FileSnapshot): Promise<FileSnapshot> {
    if (!snapshot.exists || snapshot.kind !== 'text') return { ...snapshot };
    if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: 'unavailable', text: null };
    try {
      const file = path.join(this.directory, 'blobs', snapshot.hash);
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe blob');
      const bytes = await fs.readFile(file);
      if (digest(bytes) !== snapshot.hash) throw new Error('Corrupt blob');
      return { ...snapshot, text: bytes.toString('utf8') };
    } catch { return { ...snapshot, kind: 'unavailable', text: null }; }
  }
  async writeRun(run: CaptureRun, inbox = false): Promise<void> {
    const save = async () => {
      // Shared aggregate/segment endpoints are persisted once per write; earlier segments are hash references.
      const saved = new Map<FileSnapshot, Promise<FileSnapshot>>();
      const saveSnapshot = (snapshot: FileSnapshot) => {
        let value = saved.get(snapshot);
        if (!value) { value = this.saveBlob(snapshot); saved.set(snapshot, value); }
        return value;
      };
      validId(run.id); const changes: CaptureRun['changes'] = Object.create(null);
      if (Object.keys(run.changes).length > 256) fail('STORE_LIMIT', 'Turn exceeds 256 captured files');
      const fileCount = Object.keys(run.changes).length;
      if (!fileCount) {
        // Keep only a live marker for clear/prune safety; never retain empty-turn conversations.
        if (run.state === 'running') {
          const { prompt: _prompt, finalReply: _reply, cardPreview: _preview, ...marker } = run;
          await atomicJson(path.join(this.directory, inbox ? 'inbox' : 'runs', `${run.id}.json`), { ...marker, fileCount: 0, changes: {}, replies: [], bindings: {} });
        } else {
          for (const sub of ['runs', 'inbox']) await fs.rm(path.join(this.directory, sub, `${run.id}.json`), { force: true });
        }
        return;
      }
      for (const [p, c] of Object.entries(run.changes)) {
        let diffStats = c.diffStats;
        if (diffStats?.beforeHash !== c.before.hash || diffStats?.afterHash !== c.after.hash) diffStats = undefined;
        if (!diffStats && c.before.kind === 'text' && c.after.kind === 'text' && (!c.before.exists || c.before.text !== null) && (!c.after.exists || c.after.text !== null)) {
          try { diffStats = { beforeHash: c.before.hash, afterHash: c.after.hash, ...stats(c.before.text ?? '', c.after.text ?? '') }; } catch { /* Legacy/expensive diffs remain on-demand. */ }
        }
        if (c.segments && c.segments.length > MAX_CAPTURE_SEGMENTS) fail('STORE_LIMIT', 'Too many capture segments');
        const segments = c.segments ? await Promise.all(c.segments.map(async s => ({ ...s, before: await saveSnapshot(s.before), after: await saveSnapshot(s.after) }))) : undefined;
        changes[p] = { ...c, diffStats, before: await saveSnapshot(c.before), after: await saveSnapshot(c.after), ...(segments ? { segments } : {}) };
      }
      await atomicJson(path.join(this.directory, inbox ? 'inbox' : 'runs', `${run.id}.json`), { ...run, fileCount, changes });
    };
    if (inbox) await this.captureLock(save); else await save();
  }
  async getRun(id: string, inbox = false, hydrate = true): Promise<CaptureRun | null> {
    const aliases = inbox ? undefined : await readJson<Record<string, string>>(path.join(this.directory, 'run-aliases.json'), {});
    return this.readRun(id, inbox, hydrate, aliases);
  }
  private async readRun(id: string, inbox: boolean, hydrate: boolean, aliases?: Record<string, string>): Promise<CaptureRun | null> {
    validId(id);
    if (!inbox) {
      const resolved = aliases ?? await readJson<Record<string, string>>(path.join(this.directory, 'run-aliases.json'), {});
      const seen = new Set<string>();
      while (resolved[id]) { if (seen.has(id) || seen.size >= MAX_RUNS) fail('REPAIR_IDENTITY', 'Invalid run alias chain'); seen.add(id); id = resolved[id]; validId(id); }
    }
    const run = await readJson<CaptureRun | null>(path.join(this.directory, inbox ? 'inbox' : 'runs', `${id}.json`), null);
    if (!run || !validRun(run, id)) return null;
    if (hydrate) {
      const loaded = new Map<string, Promise<FileSnapshot>>();
      const load = (snapshot: FileSnapshot) => {
        const key = JSON.stringify([snapshot.kind, snapshot.exists, snapshot.hash, snapshot.mode]);
        let pending = loaded.get(key);
        if (!pending) { pending = this.hydrate(snapshot); loaded.set(key, pending); }
        return pending;
      };
      for (const [p, c] of Object.entries(run.changes)) {
        const segments = c.segments ? await Promise.all(c.segments.map(async s => ({ ...s, before: await load(s.before), after: await load(s.after) }))) : undefined;
        run.changes[p] = { ...c, before: await load(c.before), after: await load(c.after), ...(segments ? { segments } : {}) };
      }
    }
    return run;
  }
  async importInbox(generation: string): Promise<void> {
    await this.captureLock(async () => {
    const entries = (await fs.readdir(path.join(this.directory, 'inbox'))).filter(e => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      const aliases = await readJson<Record<string, string>>(path.join(this.directory, 'run-aliases.json'), {});
      if (aliases[id]) {
        const source = await this.getRun(id, true, false), target = await this.getRun(id, false, false);
        if (source && target && source.sessionId === target.sessionId && canonical(source.root) === canonical(target.root)) {
          const saved = await readJson<CaptureRun | null>(path.join(this.directory, 'contributions', entry), null);
          if (!saved || (source.contentVersion ?? 0) > (saved.hostRecovery?.captureVersion ?? saved.contentVersion ?? 0)) {
            // Keep late source endpoints off-screen. The durable alias, not a selected
            // session/newer USER, owns them; native tool IDs still verify each endpoint.
            await atomicJson(path.join(this.directory, 'contributions', entry), { ...source, userMessageId: target.userMessageId });
            this.pendingRecovery.add(target.sessionId);
          }
          await fs.rm(path.join(this.directory, 'inbox', entry), { force: true });
        }
        continue;
      }
      try {
        const run = await this.getRun(id, true, false); if (!run) continue;
        const inboxWasRunning = run.state === 'running';
        const current = await this.getRun(id, false, false);
        if (current && (current.sessionId !== run.sessionId || canonical(current.root) !== canonical(run.root))) { await this.audit({ action: 'inbox-identity-root-conflict', runId: id, sessionId: run.sessionId }); continue; }
        if (current && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root)) {
          if ((run.contentVersion ?? 0) < (current.contentVersion ?? 0) && !current.hostRecovery) continue;
          if (current.execution && run.execution?.id === current.execution.id && run.execution.revision < current.execution.revision) continue;
        }
        // A stale inbox must not undo hash-verified native recovery or host settlement.
        // A genuinely newer capture version is still imported normally.
        if (current?.hostRecovery && (run.contentVersion ?? 0) <= current.hostRecovery.captureVersion) continue;
        // Newer whole-run captures also contain unchanged, pre-recovery entries.
        // Carry forward only exact checkpoints; changed evidence must import normally.
        if (current?.hostRecovery?.files && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root) && (!run.userMessageId || run.userMessageId === current.userMessageId)) {
          const files: Record<string, string> = Object.create(null);
          for (const [value, checkpoint] of Object.entries(current.hostRecovery.files)) {
            if (captureCheckpoint(run.changes[value]) !== checkpoint) continue;
            if (current.changes[value]) run.changes[value] = current.changes[value]; else delete run.changes[value];
            files[value] = checkpoint;
          }
          if (Object.keys(files).length) {
            run.hostRecovery = { captureVersion: run.contentVersion ?? 0, files };
            const order = [...Object.keys(current.changes).filter(value => run.changes[value]), ...Object.keys(run.changes).filter(value => !current.changes[value])];
            run.changes = Object.fromEntries(order.map(value => [value, run.changes[value]]));
          }
        }
        // A content refresh is not proof of a new execution. Keep trusted settlement
        // unless an exact runner lifecycle revision explicitly proves continuation.
        if (current && current.state !== 'running' && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root)) {
          const advanced = !!current.execution && run.execution?.id === current.execution.id && run.execution.revision > current.execution.revision;
          if (!advanced) {
            const evidenceChanged = Object.keys({ ...current.changes, ...run.changes }).some(p => captureCheckpoint(run.changes[p]) !== captureCheckpoint(current.changes[p]));
            const damaged = Object.values(run.changes).some(c => c.ambiguous || c.before.kind === 'unavailable' || c.after.kind === 'unavailable');
            run.state = current.state; run.endedAt = current.endedAt; run.execution = current.execution;
            run.userMessageId = current.userMessageId; run.replyMessageId = current.replyMessageId;
            run.finalReply = current.finalReply; run.replies = current.replies;
            // Only native recovery can disprove an unchanged legacy damage flag.
            run.incomplete = current.incomplete || damaged || (run.incomplete && (!current.hostRecovery || evidenceChanged));
          }
        }
        // Main owns bindings, but a steering continuation invalidates the previous final reply.
        const sameReply = run.finalReply?.hash === current?.finalReply?.hash && run.finalReply?.timestamp === current?.finalReply?.timestamp;
        run.bindings = sameReply ? current?.bindings ?? {} : {};
        if (run.generation !== generation && run.state === 'running') { run.state = 'incomplete'; run.incomplete = true; }
        await this.writeRun(run);
        if (!current || current.contentVersion !== run.contentVersion || current.state !== run.state || JSON.stringify(current.changes) !== JSON.stringify(run.changes)) this.pendingRecovery.add(run.sessionId);
        // Open runs remain an inbox source; settled ones have no late writer once retired.
        if (run.state !== 'running' && !inboxWasRunning) await fs.rm(path.join(this.directory, 'inbox', entry), { force: true });
      } catch { /* A corrupt capture is isolated, never imported as trusted history. */ }
    }
    });
  }
  async captureContributions(): Promise<CaptureRun[]> {
    const files = (await fs.readdir(path.join(this.directory, 'contributions'))).filter(file => /^[\w-]+\.json$/.test(file)).slice(-MAX_RUNS * 2);
    const sources: CaptureRun[] = [];
    for (const file of files) {
      const id = file.slice(0, -5), source = await readJson<CaptureRun | null>(path.join(this.directory, 'contributions', file), null);
      if (!source || !validRun(source, id)) continue;
      const target = await this.getRun(id, false, false);
      if (target?.id !== id && target?.sessionId === source.sessionId && canonical(target.root) === canonical(source.root) && target.userMessageId === source.userMessageId) sources.push(source);
    }
    return sources;
  }
  async listRuns(hydrate = true, includeUnchanged = false): Promise<CaptureRun[]> {
    const files = (await fs.readdir(path.join(this.directory, 'runs'))).filter(e => /^[\w-]+\.json$/.test(e));
    if (!files.length) return [];
    const aliases = await readJson<Record<string, string>>(path.join(this.directory, 'run-aliases.json'), {}).catch(() => null);
    if (!aliases) return [];
    const runs: CaptureRun[] = [];
    // Bounded parallel metadata reads; history size must not serialize hundreds of disk round trips.
    const selected = files.slice(-MAX_RUNS * 2);
    for (let offset = 0; offset < selected.length; offset += 16) {
      const page = await Promise.all(selected.slice(offset, offset + 16).map(async file => {
        try { return await this.readRun(file.slice(0, -5), false, hydrate, aliases); } catch { return null; }
      }));
      for (const run of page) if (run && !runs.some(r => r.id === run.id) && (includeUnchanged || Object.keys(run.changes).length > 0)) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
  }
  async comments(): Promise<ReviewComment[]> { return readJson<ReviewComment[]>(path.join(this.directory, 'comments.json'), []); }
  async saveComments(comments: ReviewComment[]): Promise<void> { if (comments.length > 1000 || Buffer.byteLength(JSON.stringify(comments)) > 16 * 1024 * 1024) fail('COMMENT_LIMIT', 'Comment count or byte limit reached'); await atomicJson(path.join(this.directory, 'comments.json'), comments); }
  async audit(event: unknown): Promise<void> {
    const file = path.join(this.directory, 'actions.jsonl');
    const size = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    if (size > 1024 * 1024) await fs.rename(file, `${file}.previous`).catch(() => {});
    await fs.appendFile(file, `${JSON.stringify({ timestamp: Date.now(), event })}\n`, { mode: 0o600 });
  }
  async prune(): Promise<void> {
    const runs = await this.listRuns(false, true); let used = 0; const keep = new Set<string>();
    for (const run of runs) {
      const hashes = Object.values(run.changes).flatMap(c => [c.before, c.after]).filter(s => s.exists && s.kind === 'text');
      const cost = hashes.reduce((n, s) => n + s.size, 0);
      if (used + cost <= MAX_HISTORY_BYTES || run.state === 'running') { used += cost; keep.add(run.id); }
    }
    for (const file of await fs.readdir(path.join(this.directory, 'runs'))) if (/^[\w-]+\.json$/.test(file) && !keep.has(file.slice(0, -5))) await fs.rm(path.join(this.directory, 'runs', file), { force: true });
    // Do not GC blobs while a capture writer is live. A history reset is the safe collection point.
  }
  async clear(): Promise<void> {
    await this.captureLock(async () => {
      for (const inbox of [false, true]) for (const file of await fs.readdir(path.join(this.directory, inbox ? 'inbox' : 'runs'))) {
        if (!/^[\w-]+\.json$/.test(file)) continue;
        const run = await this.getRun(file.slice(0, -5), inbox, false);
        if (run?.state === 'running') fail('AGENT_BUSY', 'Stop active captures before clearing history');
      }
      for (const sub of ['runs', 'inbox', 'contributions', 'blobs', 'backups', 'evidence']) {
        const dir = path.join(this.directory, sub);
        if (!inside(this.directory, dir)) fail('STORE_ESCAPE', 'Invalid store path');
        for (const file of await fs.readdir(dir)) { const target = path.join(dir, file); const s = await fs.lstat(target); if (s.isFile() && !s.isSymbolicLink()) await fs.unlink(target); }
      }
      await this.saveComments([]); await fs.rm(path.join(this.directory, 'restores.json'), { force: true });
      await fs.rm(path.join(this.directory, 'run-aliases.json'), { force: true });
      await fs.rm(path.join(this.directory, 'file-aliases.json'), { force: true });
      this.pendingRecovery.clear();
    });
  }
}
