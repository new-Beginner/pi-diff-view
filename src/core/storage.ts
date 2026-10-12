import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertPublicPath, canonical, digest, fail, inside, sameSnapshot } from './path-policy';
import { stats } from './diff';
import type { CaptureRun, FileSnapshot, ReviewComment } from './contracts';
export const MAX_RUNS = 200;
export const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
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
      for (const snapshot of [change.before, change.after]) if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.hash !== 'string' || !Number.isFinite(snapshot.size) || snapshot.size < 0 || !Number.isFinite(snapshot.mode) || !['text', 'binary', 'large', 'symlink', 'submodule', 'conflict', 'unavailable'].includes(snapshot.kind)) return false;
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
  constructor(readonly directory: string) {}
  async init(): Promise<void> { for (const sub of ['blobs', 'inbox', 'runs', 'backups', 'evidence']) await fs.mkdir(path.join(this.directory, sub), { recursive: true, mode: 0o700 }); }
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
          for (const entry of entries) size += (await fs.stat(path.join(path.dirname(file), entry))).size;
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
        changes[p] = { ...c, diffStats, before: await this.saveBlob(c.before), after: await this.saveBlob(c.after) };
      }
      await atomicJson(path.join(this.directory, inbox ? 'inbox' : 'runs', `${run.id}.json`), { ...run, fileCount, changes });
    };
    if (inbox) await this.captureLock(save); else await save();
  }
  async getRun(id: string, inbox = false, hydrate = true): Promise<CaptureRun | null> {
    validId(id);
    const run = await readJson<CaptureRun | null>(path.join(this.directory, inbox ? 'inbox' : 'runs', `${id}.json`), null);
    if (!run || !validRun(run, id)) return null;
    if (hydrate) for (const [p, c] of Object.entries(run.changes)) run.changes[p] = { ...c, before: await this.hydrate(c.before), after: await this.hydrate(c.after) };
    return run;
  }
  async importInbox(generation: string): Promise<void> {
    await this.captureLock(async () => {
    const entries = (await fs.readdir(path.join(this.directory, 'inbox'))).filter(e => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      try {
        const run = await this.getRun(id, true, false); if (!run) continue;
        const current = await this.getRun(id, false, false);
        // A stale inbox must not undo hash-verified native recovery or host settlement.
        // A genuinely newer capture version is still imported normally.
        if (current?.hostRecovery && (run.contentVersion ?? 0) <= current.hostRecovery.captureVersion) continue;
        // Main owns bindings, but a steering continuation invalidates the previous final reply.
        const sameReply = run.finalReply?.hash === current?.finalReply?.hash && run.finalReply?.timestamp === current?.finalReply?.timestamp;
        run.bindings = sameReply ? current?.bindings ?? {} : {};
        if (run.generation !== generation && run.state === 'running') { run.state = 'incomplete'; run.incomplete = true; }
        await this.writeRun(run);
        // Open runs remain an inbox source; settled ones have no late writer once retired.
        if (run.state !== 'running') await fs.rm(path.join(this.directory, 'inbox', entry), { force: true });
      } catch { /* A corrupt capture is isolated, never imported as trusted history. */ }
    }
    });
  }
  async listRuns(hydrate = true, includeUnchanged = false): Promise<CaptureRun[]> {
    const files = (await fs.readdir(path.join(this.directory, 'runs'))).filter(e => /^[\w-]+\.json$/.test(e));
    const runs: CaptureRun[] = [];
    // Bounded parallel metadata reads; history size must not serialize hundreds of disk round trips.
    const selected = files.slice(-MAX_RUNS * 2);
    for (let offset = 0; offset < selected.length; offset += 16) {
      const page = await Promise.all(selected.slice(offset, offset + 16).map(async file => {
        try { return await this.getRun(file.slice(0, -5), false, hydrate); } catch { return null; }
      }));
      for (const run of page) if (run && (includeUnchanged || Object.keys(run.changes).length > 0)) runs.push(run);
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
      for (const sub of ['runs', 'inbox', 'blobs', 'backups', 'evidence']) {
        const dir = path.join(this.directory, sub);
        if (!inside(this.directory, dir)) fail('STORE_ESCAPE', 'Invalid store path');
        for (const file of await fs.readdir(dir)) { const target = path.join(dir, file); const s = await fs.lstat(target); if (s.isFile() && !s.isSymbolicLink()) await fs.unlink(target); }
      }
      await this.saveComments([]); await fs.rm(path.join(this.directory, 'restores.json'), { force: true });
    });
  }
}
