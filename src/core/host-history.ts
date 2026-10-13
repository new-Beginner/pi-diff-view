import { collectDelegations } from './delegation-lifecycle';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MAX_TEXT_BYTES, type CaptureRun, type CapturedChange, type CaptureIdentity, type FileSnapshot } from './contracts';
import { absentSnapshot, assertPublicPath, canonical, digest, inside, snapshotFromBytes } from './path-policy';
import { isImagePath } from './review-file-policy';
import { replayRecordedEdit } from './edit-replay';
import { atomicJson, captureCheckpoint, type SnapshotStore } from './storage';

type RecordValue = Record<string, any>;
type HistoryChange = CapturedChange & { note?: string; oldPath?: string };
export type HostHistoryRun = CaptureRun & { userMessageId?: string; replyMessageId?: string; source?: 'host-history'; notice?: string };
export interface HostHistoryDiagnostics { imported: number; unchanged: number; skipped: number; events: number; runIds: string[]; warnings: string[] }
interface Message { id: string; role: string; blocks: RecordValue[]; meta: RecordValue; createdAt: number; order: number; parent?: string }
interface Event { meta: RecordValue; directory?: string; message: Message; block?: RecordValue; before?: FileSnapshot; after?: FileSnapshot; toolOnly?: boolean; capturedBefore?: boolean }
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): number => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : 0; return Number.isFinite(n) ? n : 0; };
export const hostHistoryRunId = (sessionId: string, userMessageId: string): string => `host-${digest(`${sessionId}\0${userMessageId}`).slice(0, 48)}`;
const unknownSnapshot = (exists: boolean, hash: unknown, label: string): FileSnapshot => ({ exists, text: null, hash: typeof hash === 'string' && HASH.test(hash) ? hash : `unavailable:${label}`, size: 0, mode: 0, kind: 'unavailable' });

/** Trusted constructor root only; callers may select a session, never a source directory.
 * No workspace stat/read/realpath or Git operation is used to reconstruct history.
 */
export class HostHistoryImporter {
  private readonly hostDataRoot: string;
  constructor(private readonly store: SnapshotStore, hostDataRoot: string) {
    if (!path.isAbsolute(hostDataRoot)) throw new Error('Host data root must be absolute');
    this.hostDataRoot = path.resolve(hostDataRoot);
  }
  /** Native session scratch contract; this root is for recording only, never disk actions. */
  scratchRoot(sessionId: string): string {
    if (!ID.test(sessionId)) throw new Error('Invalid history session');
    return path.join(this.hostDataRoot, 'scratch', sessionId);
  }
  private async checked(relative: string, directory = false): Promise<string> {
    const target = path.resolve(this.hostDataRoot, relative);
    if (!inside(this.hostDataRoot, target)) throw new Error('Host evidence escape');
    let cursor = path.parse(target).root;
    for (const segment of target.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== target && !stat.isDirectory())) throw new Error('Unsafe host evidence ancestry');
    }
    const stat = await fs.lstat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid host evidence type');
    return target;
  }
  private async read(relative: string, limit: number): Promise<Buffer> {
    const file = await this.checked(relative);
    const initial = await fs.lstat(file);
    const handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new Error('Host evidence limit/identity');
      const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
      let length = 0;
      while (length < bytes.length) { const r = await handle.read(bytes, length, bytes.length - length, length); if (!r.bytesRead) break; length += r.bytesRead; }
      const after = await handle.stat();
      await this.checked(relative);
      const live = await fs.lstat(file);
      if (length > limit || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || live.ino !== stat.ino || live.dev !== stat.dev) throw new Error('Host evidence changed; retry sync');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  private capture(root: string, value: string, sessionId: string): CaptureIdentity {
    assertPublicPath(value);
    const absolutePath = path.resolve(root, value);
    assertPublicPath(absolutePath);
    if ((inside(this.hostDataRoot, absolutePath) && !inside(this.scratchRoot(sessionId), absolutePath)) || inside(this.store.directory, absolutePath)) throw new Error('Private history path');
    const origin = inside(root, absolutePath) ? 'workspace' : 'external';
    if (origin === 'external' && !path.isAbsolute(value)) throw new Error('Relative external history path');
    const display = origin === 'workspace' ? path.relative(root, absolutePath).split(path.sep).join('/') : absolutePath;
    assertPublicPath(display);
    const identity = canonical(absolutePath);
    return { id: digest(identity).slice(0, 24), identity, path: display, absolutePath, origin };
  }
  private async snapshot(event: Event, side: 'before' | 'after'): Promise<FileSnapshot> {
    const m = event.meta, exists = m[`${side}Exists`], hash = m[`${side}Hash`];
    if (exists === false) return absentSnapshot();
    if (event.directory) {
      try {
        const bytes = await this.read(`${event.directory}/${side}`, MAX_TEXT_BYTES);
        // A before file is itself host evidence; after requires a matching recorded hash.
        if ((side === 'before' && !hash) || (typeof hash === 'string' && HASH.test(hash) && digest(bytes) === hash)) return snapshotFromBytes(bytes, 0);
      } catch { /* Missing/corrupt/oversized evidence stays explicitly unavailable. */ }
    }
    return unknownSnapshot(exists !== false, hash, `${m.messageId}:${side}`);
  }
  async syncSession(sessionId: string, root: string, options: { running?: boolean; mainRunning?: boolean; statusKnown?: boolean; taskId?: string; since?: number; messages?: unknown[]; repairRootConflicts?: boolean; repairUserMessageId?: string } | boolean = {}): Promise<HostHistoryDiagnostics> {
    if (!ID.test(sessionId) || !path.isAbsolute(root)) throw new Error('Invalid history session/root');
    root = path.resolve(root);
    const capture = (value: string) => this.capture(root, value, sessionId);
    const running = typeof options === 'boolean' ? options : options.running === true;
    const mainRunning = typeof options === 'boolean' ? options : options.mainRunning ?? running;
    const statusKnown = typeof options === 'boolean' || options.statusKnown !== false;
    const taskId = typeof options !== 'boolean' && typeof options.taskId === 'string' && /^[a-zA-Z0-9-]{1,256}$/.test(options.taskId) ? options.taskId : undefined;
    const since = typeof options !== 'boolean' && Number.isSafeInteger(options.since) && options.since! > 0 && options.since! <= Date.now() ? options.since : undefined;
    const d: HostHistoryDiagnostics = { imported: 0, unchanged: 0, skipped: 0, events: 0, runIds: [], warnings: [] };
    const warn = (value: string) => { if (d.warnings.length < 100 && !d.warnings.includes(value)) d.warnings.push(value); };
    // Empty source-owned markers contain no history to lose. Retire them from
    // authoritative idle/new-task metadata even if the transcript has not flushed.
    if (statusKnown && (!running || taskId)) {
      await this.store.init();
      await this.store.captureLock(async () => {
        for (const marker of await this.store.listRuns(false, true)) {
          if (marker.sessionId !== sessionId || canonical(marker.root) !== canonical(root) || marker.source !== 'host-history' || marker.boundary !== 'user' || marker.state !== 'running' || Object.keys(marker.changes).length || (running && marker.userMessageId === taskId)) continue;
          marker.state = 'incomplete'; marker.incomplete = true;
          await this.store.writeRun(marker); // Empty settled turns are removed by storage.
        }
      });
    }
    let source: string;
    try { source = (await this.read(`sessions/${sessionId}.jsonl`, 64 * 1024 * 1024)).toString('utf8'); }
    catch { if ((typeof options === 'boolean' || !options.messages?.length) && !(taskId && since)) { warn('Session evidence unavailable or unsafe'); return d; } source = ''; }
    const messages = new Map<string, Message>();
    let malformed = false, order = 0;
    const liveMessages = typeof options === 'boolean' ? [] : options.messages ?? [];
    for (const line of [...source.split('\n'), ...liveMessages.map(r => JSON.stringify(r))]) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (!object(r)) throw new Error();
        if (r.type === 'session' && r.sessionId !== sessionId) { warn('Session header mismatch'); return d; }
        if (r.type !== 'message' || typeof r.id !== 'string' || r.id.length > 512 || typeof r.role !== 'string') continue;
        const meta = object(r.meta) ? r.meta : {};
        if (messages.size >= 100000 && !messages.has(r.id)) { warn('Session message limit exceeded'); return d; }
        messages.set(r.id, { id: r.id, role: r.role, blocks: Array.isArray(r.blocks) ? r.blocks.filter(object) : [], meta, createdAt: time(r.createdAt), order: messages.get(r.id)?.order ?? order++, parent: meta.parentMessageId ?? r.parentMessageId });
      } catch { malformed = true; }
    }
    if (malformed) { warn('Malformed/truncated session lines; no turn attribution attempted'); return d; }
    // The renderer's current user metadata may arrive before JSONL. Keep an empty
    // live marker, not fabricated modification evidence or conversational content.
    if (taskId && since && !messages.has(taskId)) messages.set(taskId, { id: taskId, role: 'user', blocks: [], meta: {}, createdAt: since, order: order++ });
    const ordered = [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
    ordered.forEach((m, index) => { m.order = index; });
    const owners = new Map<string, string>(), aliases = new Map<string, Message>();
    let current: string | undefined;
    for (const m of ordered) {
      if (m.role === 'user' && !m.parent && !m.meta.steering) current = m.id;
      if (current && !m.parent) owners.set(m.id, current);
      aliases.set(m.id, m);
      for (const b of m.blocks) if (b.type === 'tool_call' && typeof b.callId === 'string') aliases.set(b.callId, m);
    }
    const owner = (m: Message, seen = new Set<string>()): string | undefined => {
      if (seen.has(m.id)) return undefined;
      seen.add(m.id);
      if (m.meta.userMessageId !== undefined) { const user = aliases.get(m.meta.userMessageId); return user?.role === 'user' && !user.parent ? user.id : undefined; }
      if (m.parent) { const parent = aliases.get(m.parent); return parent ? owner(parent, seen) : undefined; }
      return owners.get(m.id);
    };
    const delegations = collectDelegations(ordered, message => owner(message as Message));
    const events: Event[] = [], eventKeys = new Set<string>();
    const add = (meta: RecordValue, directory?: string, toolOnly = false) => {
      if (meta.sessionId !== sessionId || meta.version !== 1 || typeof meta.path !== 'string' || typeof meta.messageId !== 'string') { d.skipped++; return; }
      if (isImagePath(meta.path)) { d.skipped++; return; }
      const message = aliases.get(meta.messageId);
      if (!message || !owner(message)) { d.skipped++; warn('Unlinked host modification evidence'); return; }
      const block = message.blocks.find(b => b.type === 'tool_call' && b.callId === meta.messageId)
        ?? (message.id === meta.messageId && message.blocks.filter(b => b.type === 'tool_call').length === 1 ? message.blocks.find(b => b.type === 'tool_call') : undefined);
      const tool = String(block?.name ?? '').split('.').pop()!.toLowerCase();
      if (!block || !['write', 'edit'].includes(tool)) { d.skipped++; return; }
      let identity: string;
      try { identity = capture(meta.path).identity; if (meta.oldPath) capture(meta.oldPath); } catch { d.skipped++; return; }
      // Native evidence is accepted only when tied to an explicit standard
      // mutation tool; Bash/Shell/Task endpoints are not authorship evidence.
      const key = `${block.callId}\0${identity}`;
      if (eventKeys.has(key)) return;
      eventKeys.add(key);
      events.push({ meta: { ...meta, messageId: block.callId }, directory, message, block, toolOnly });
    };
    const relative = `review-changes/${sessionId}`;
    try {
      const dir = await this.checked(relative, true);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.length > 4096) { warn('Host modification directory limit exceeded'); return d; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        try { const m: unknown = JSON.parse((await this.read(`${relative}/${entry.name}/meta.json`, 64 * 1024)).toString('utf8')); if (object(m)) add(m, `${relative}/${entry.name}`); }
        catch { warn('Missing/corrupt host modification metadata'); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('Host modification directory unavailable or unsafe'); }
    // Structured host reviews are evidence even when their snapshot folder has disappeared.
    // Never interpret Bash command strings/stdout as modification events.
    for (const m of ordered) for (const b of m.blocks) {
      const review = b.result?.details?.review;
      if (b.type !== 'tool_call' || b.status !== 'success' || b.result?.isError) continue;
      if (object(review)) {
        if ((review.messageId !== m.id && review.messageId !== b.callId) || (review.sessionId !== undefined && review.sessionId !== sessionId)) { d.skipped++; continue; }
        add({ ...review, messageId: b.callId, sessionId, beforeExists: review.beforeExists ?? (review.status === 'added' ? false : undefined), afterExists: review.afterExists ?? (review.status === 'deleted' ? false : undefined) });
      } else {
        // Successful native Write/Edit calls are evidence even without native review snapshots.
        // Missing before bytes stay unknown; never assume Write created an absent file.
        const name = String(b.name).split('.').pop()!.toLowerCase(), target = b.args?.path ?? b.args?.file_path;
        if (!['write', 'edit'].includes(name) || typeof target !== 'string' || (!path.isAbsolute(target) && canonical(root) !== canonical(this.scratchRoot(sessionId))) || typeof b.callId !== 'string') continue;
        const text = name === 'write' && typeof b.args.content === 'string' && Buffer.byteLength(b.args.content) <= MAX_TEXT_BYTES ? b.args.content : undefined;
        add({ version: 1, sessionId, messageId: b.callId, path: target, operation: name, ...(text !== undefined ? { afterExists: true, afterHash: digest(text) } : {}) }, undefined, true);
      }
    }
    events.sort((a, b) => a.message.order - b.message.order);
    if (events.length > 4096) { warn('Host event limit exceeded'); return d; }
    await this.store.init();
    const capturedEndpoints = new Map<string, FileSnapshot[]>();
    const sources = [...await this.store.listRuns(false, true), ...await this.store.captureContributions()];
    for (const source of sources) {
      if (source.sessionId !== sessionId || canonical(source.root) !== canonical(root) || !source.userMessageId) continue;
      for (const change of Object.values(source.changes)) {
        if (change.ambiguous || !change.capture || !change.evidence?.length) continue;
        for (const side of ['before', 'after'] as const) {
          const ref = side === 'before' ? change.evidence[0] : change.evidence.at(-1)!;
          const callId = ref.slice(ref.indexOf(':') + 1), message = aliases.get(callId);
          if (!/^(native|write|edit):/.test(ref) || !message || owner(message) !== source.userMessageId) continue;
          const key = `${callId}\0${change.capture.identity}\0${side}`;
          capturedEndpoints.set(key, [...(capturedEndpoints.get(key) ?? []), change[side]]);
        }
      }
    }
    let evidenceBytes = 0;
    for (const e of events) {
      e.before = await this.snapshot(e, 'before'); e.after = await this.snapshot(e, 'after');
      for (const side of ['before', 'after'] as const) {
        if (e[side]!.kind !== 'unavailable') continue;
        const endpoints = capturedEndpoints.get(`${e.meta.messageId}\0${capture(e.meta.path).identity}\0${side}`) ?? [];
        const unique = new Map(endpoints.map(snapshot => [JSON.stringify([snapshot.hash, snapshot.exists]), snapshot]));
        if (unique.size !== 1) continue;
        const snapshot = unique.values().next().value!;
        if (HASH.test(e.meta[`${side}Hash`] ?? '') && snapshot.hash !== e.meta[`${side}Hash`]) continue;
        if (typeof e.meta[`${side}Exists`] === 'boolean' && snapshot.exists !== e.meta[`${side}Exists`]) continue;
        const verified = await this.store.hydrate(snapshot);
        if (verified.kind === 'text') { e[side] = verified; if (side === 'before') e.capturedBefore = true; }
      }
      evidenceBytes += e.before.size + e.after.size;
      if (evidenceBytes > 64 * 1024 * 1024) { warn('Host snapshot byte limit exceeded'); return d; }
    }
    // Only hash-addressed historical bytes corroborate missing sides, including later before
    // snapshots. Newly reconstructed content can unlock another event; never read the workspace.
    const evidence = new Map<string, FileSnapshot>(), waiting = new Map<string, Set<Event>>();
    const queue = [...events], queued = new Set(queue);
    const remember = (snapshot: FileSnapshot) => {
      if (snapshot.kind !== 'text' || !snapshot.exists || snapshot.text === null || evidence.has(snapshot.hash)) return;
      evidence.set(snapshot.hash, snapshot);
      for (const event of waiting.get(snapshot.hash) ?? []) if (!queued.has(event)) { queue.push(event); queued.add(event); }
    };
    for (const event of events) for (const side of ['before', 'after'] as const) {
      const snapshot = event[side]!;
      if (snapshot.kind === 'unavailable' && HASH.test(snapshot.hash)) {
        const dependents = waiting.get(snapshot.hash) ?? new Set<Event>(); dependents.add(event); waiting.set(snapshot.hash, dependents);
      }
    }
    for (const event of events) { remember(event.before!); remember(event.after!); }
    await this.store.init();
    const needed = new Set(events.flatMap(e => [e.before!, e.after!]).filter(s => s.kind === 'unavailable' && HASH.test(s.hash)).map(s => s.hash));
    // Native evidence can be cleaned by the host. Reuse only exact hash-verified
    // plugin blobs referenced by this session/root; never use current workspace bytes.
    if (needed.size) for (const saved of await this.store.listRuns(false, true)) {
      if (saved.sessionId !== sessionId || canonical(saved.root) !== canonical(root)) continue;
      for (const change of Object.values(saved.changes)) for (const side of ['before', 'after'] as const) {
        const snapshot = change[side];
        if (!needed.has(snapshot.hash) || evidence.has(snapshot.hash)) continue;
        const restored = await this.store.hydrate({ ...snapshot, kind: 'text' });
        if (restored.kind !== 'text') continue;
        evidenceBytes += restored.size;
        if (evidenceBytes > 128 * 1024 * 1024) { warn('Host recovered byte limit exceeded'); return d; }
        remember(restored);
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const e = queue[index], b = e.block; queued.delete(e);
      for (const side of ['before', 'after'] as const) if (e[side]!.kind === 'unavailable' && evidence.has(e[side]!.hash)) e[side] = evidence.get(e[side]!.hash);
      if (e.after!.kind !== 'unavailable' || b?.status !== 'success' || b.result?.isError || !HASH.test(e.meta.afterHash ?? '')) continue;
      let text: string | undefined;
      if (String(b.name).split('.').pop()!.toLowerCase() === 'write' && typeof b.args?.content === 'string') {
        const p = b.args.path ?? b.args.file_path;
        try { if (typeof p === 'string' && capture(p).identity === capture(e.meta.path).identity) text = b.args.content; } catch { /* Invalid tool path. */ }
      }
      if (text === undefined && e.before!.kind === 'text') {
        try { text = applyReview(e.before!.text ?? '', b.result?.details?.review?.hunks, e.meta.afterHash); } catch { /* Oversized or malformed hunks are not full-text evidence. */ }
        if (text === undefined && String(b.name).split('.').pop()!.toLowerCase() === 'edit') {
          const target = b.args?.path ?? b.args?.file_path;
          try {
            if (typeof target === 'string' && capture(target).identity === capture(e.meta.path).identity) text = replayRecordedEdit(e.before!.text ?? '', b.args, e.meta.afterHash);
          } catch { /* Invalid path or unsupported edit stays unavailable. */ }
        }
      }
      if (text !== undefined && Buffer.byteLength(text) <= MAX_TEXT_BYTES && digest(text) === e.meta.afterHash) {
        evidenceBytes += Buffer.byteLength(text);
        if (evidenceBytes > 128 * 1024 * 1024) { warn('Host reconstructed byte limit exceeded'); return d; }
        e.after = snapshotFromBytes(Buffer.from(text), 0); remember(e.after);
      }
    }
    d.events = events.length;
    await this.store.init();
    await this.store.captureLock(async () => {
      const existing = await this.store.listRuns(false, true) as HostHistoryRun[];
      const users = ordered.filter(m => m.role === 'user' && !m.parent && !m.meta.steering);
      const nextBoundary = new Map(users.slice(0, -1).map((user, index) => [user.id, users[index + 1].createdAt]));
      const standardEvidence = (ref: string) => {
        const separator = ref.indexOf(':');
        if (separator < 0) return false;
        const source = ref.slice(0, separator).toLowerCase(), id = ref.slice(separator + 1);
        if (source === 'native') {
          const message = aliases.get(id);
          return !!message?.blocks.some(b => b.type === 'tool_call' && b.callId === id && ['write', 'edit'].includes(String(b.name).split('.').pop()!.toLowerCase()));
        }
        return ['write', 'edit'].includes(source);
      };
      const refOwner = (ref: string) => {
        const callId = ref.slice(ref.indexOf(':') + 1), message = aliases.get(callId);
        return message?.blocks.some(b => b.type === 'tool_call' && b.callId === callId) ? owner(message) : undefined;
      };
      // Earlier buggy recovery could copy an old turn into a new capture with a stale
      // user binding. Only discard importer-owned entries with exact old tool ownership;
      // original, mixed and unlinked capture evidence must remain untouched.
      const foreignRecovery = (run: CaptureRun, value: string, change: CapturedChange) =>
        run.hostRecovery?.files?.[value] !== undefined && !!change.evidence?.length && change.evidence.every(ref => {
          const boundary = nextBoundary.get(refOwner(ref) ?? '');
          return ref.startsWith('native:') && !!boundary && run.startedAt >= boundary;
        });
      for (const user of users) {
        const turnEvents = events.filter(e => owner(e.message) === user.id);
        const mainLive = statusKnown && mainRunning && (taskId ? user.id === taskId : user === users.at(-1));
        const children = delegations.filter(child => child.owner === user.id);
        const live = mainLive || children.some(child => child.status === 'running');
        const id = hostHistoryRunId(sessionId, user.id);
        const duplicates = existing.filter(r => {
          if (r.sessionId !== sessionId || canonical(r.root) !== canonical(root) || r.source === 'host-history') return false;
          // Exact original tool ownership overrides an obsolete context binding.
          const attributable = Object.entries(r.changes).filter(([value, change]) => !foreignRecovery(r, value, change) && (change.evidence ?? []).every(standardEvidence));
          const linkedOwners = attributable.flatMap(([, c]) => c.evidence ?? []).map(refOwner);
          const rejectedOwners = Object.values(r.changes).flatMap(change => (change.evidence ?? []).filter(ref => !standardEvidence(ref)).map(refOwner));
          if (rejectedOwners.length && rejectedOwners.every(id => id === user.id)) return true;
          const verifiedOwner = linkedOwners[0] && attributable.every(([, c]) => !!c.evidence?.length) && linkedOwners.every(id => id === linkedOwners[0]) ? linkedOwners[0] : undefined;
          if (verifiedOwner) return verifiedOwner === user.id;
          if (linkedOwners.some(id => id && id !== user.id)) return false;
          // A later USER boundary disproves a stale binding; time never proves a merge.
          const boundary = nextBoundary.get(user.id);
          return r.userMessageId === user.id && !(boundary && r.startedAt >= boundary);
        }).sort((a, b) => a.startedAt - b.startedAt);
        const duplicate = duplicates[0];
        // Merge only by a stable user identity, directly recorded or corroborated by exact tool IDs.
        const candidate = await this.store.getRun(id) as HostHistoryRun | null;
        const previous = candidate?.id === id ? candidate : null; // Retired IDs resolve for navigation, not as new source records.
        const members = ordered.filter(m => owner(m) === user.id && !m.parent);
        const last = members.filter(m => m.role === 'assistant' || m.role === 'tool').at(-1);
        const reply = !mainLive && last?.role === 'assistant' && last.meta.status === 'complete' && last.blocks.some(b => b.type === 'text') ? last : undefined;
        let migrating = false;
        if (previous && (previous.source !== 'host-history' || previous.sessionId !== sessionId || previous.userMessageId !== user.id)) { d.skipped++; warn('Existing run identity conflict; content preserved'); continue; }
        if (previous && canonical(previous.root) !== canonical(root)) {
          // Root migration is opt-in and restricted to a demonstrably mis-scoped scratch record.
          // Exact tool IDs, absolute path identity and native endpoint hashes must corroborate every old file.
          const verified = canonical(previous.root) === canonical(this.scratchRoot(sessionId)) && Object.values(previous.changes).every(change => {
            const mapped = change.capture?.origin === 'workspace' ? capture(change.capture.path).identity : change.capture?.identity;
            const linked = turnEvents.filter(e => capture(e.meta.path).identity === mapped);
            return !!linked.length && !!change.evidence?.length && change.evidence.every(ref => ref.startsWith('native:') && linked.some(e => ref === `native:${e.meta.messageId}` && e.block?.status === 'success'))
              && change.before.hash === linked[0].before!.hash && linked.some(e => e.after!.hash === change.after.hash)
              && linked.every(e => e.before!.kind === 'text' && e.after!.kind === 'text');
          });
          migrating = typeof options !== 'boolean' && options.repairRootConflicts === true && (!options.repairUserMessageId || options.repairUserMessageId === user.id) && verified && duplicates.length === 1;
          if (!migrating) {
            // Content failure cannot freeze independent, exact user final-message evidence.
            if (reply && (previous.state !== 'completed' || previous.endedAt !== reply.createdAt)) {
              previous.state = 'completed'; previous.endedAt = reply.createdAt; previous.replyMessageId = reply.id;
              previous.incomplete = true; previous.notice = '根目录冲突：内容被冻结，完成状态由同会话用户轮次的最终回复核验；需显式授权迁移。';
              previous.contentVersion = (previous.contentVersion ?? 0) + 1; await this.store.writeRun(previous);
            }
            d.skipped++; warn('Existing run root conflict; content frozen; verified repair requires explicit approval'); continue;
          }
          const reviewState = Object.fromEntries(await Promise.all(['comments.json', 'selections.json', 'restores.json', 'run-aliases.json', 'file-aliases.json'].map(async file => [file, await fs.readFile(path.join(this.store.directory, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })])));
          await atomicJson(path.join(this.store.directory, 'backups', `repair-${id}-${previous.contentVersion ?? 0}.json`), { version: 1, sessionId, root, previous, duplicates, reviewState, createdAt: Date.now() });
        }
        if (!turnEvents.length && !live && !duplicate && !previous) continue;
        const saved = previous ?? (duplicate ? await this.store.getRun(duplicate.id) : null);
        const retainedReply = !live && !reply && saved?.replyMessageId && saved.endedAt != null && members.every(m => m.createdAt <= saved.endedAt!) ? saved.replyMessageId : undefined;
        const replyId = reply?.id ?? retainedReply;
        const changes: Record<string, HistoryChange> = Object.create(null);
        for (const e of turnEvents) {
          const c = capture(e.meta.path), old = changes[c.path];
          const recorded = saved?.changes[c.path];
          // Cleanup must not discard already verified bytes for this exact final tool/file.
          if (e.toolOnly && recorded?.capture?.identity === c.identity && [`native:${e.block?.callId}`, `native:${e.message.id}`].includes(recorded.evidence?.at(-1) ?? '')) {
            for (const side of ['before', 'after'] as const) if (e[side]!.kind === 'unavailable' && !HASH.test(e[side]!.hash)) e[side] = recorded[side];
          }
          const note = ['原生历史修改事件；未读取当前文件。', e.meta.state === 'reverted' ? '主程序已标记撤销；此处保留原修改证据。' : '', e.meta.oldPath ? `重命名来源：${e.meta.oldPath}` : '', e.before!.kind === 'unavailable' || e.after!.kind === 'unavailable' ? '历史完整内容不可用，无法可靠计算完整差异。' : ''].filter(Boolean).join(' ');
          const discontinuous = !!old && (old.ambiguous || ((!e.toolOnly || e.capturedBefore) && old.after.kind === 'text' && e.before!.kind === 'text' && (old.after.hash !== e.before!.hash || old.after.exists !== e.before!.exists)));
          changes[c.path] = { capture: c, before: old?.before ?? e.before!, after: e.after!, note: discontinuous ? `${note} 并发或不连续的文件快照，不能作为自动合并；行数未知。` : note, evidence: [...(old?.evidence ?? []), `native:${e.meta.messageId}`].slice(-32), ...(discontinuous ? { ambiguous: true } : {}), ...(e.meta.oldPath ? { oldPath: e.meta.oldPath } : {}) };
        }
        if (previous && !migrating) for (const [value, change] of Object.entries(previous.changes)) if (!isImagePath(value) && !changes[value] && (change.evidence ?? []).every(standardEvidence)) changes[value] = change;
        if (Object.keys(changes).length > 256) { warn('Turn exceeds 256 files; import skipped'); d.skipped++; continue; }
        const stopped = last?.meta.status === 'aborted' || children.some(child => ['aborted', 'stopped'].includes(child.status));
        const failed = last?.meta.status === 'error' || children.some(child => child.status === 'failed');
        const incomplete = stopped || failed || Object.values(changes).some(c => c.ambiguous || c.before.kind === 'unavailable' || c.after.kind === 'unavailable') || (!replyId && !live);
        const unresolved = !statusKnown && !replyId && !live;
        const run: HostHistoryRun = { version: 2, id, sessionId, root, generation: 'host-history', source: 'host-history', userMessageId: user.id, replyMessageId: replyId, boundary: 'user', startedAt: user.createdAt, endedAt: live || unresolved ? undefined : Math.max(retainedReply ? saved!.endedAt! : last?.createdAt ?? turnEvents.at(-1)?.message.createdAt ?? user.createdAt, ...children.map(child => child.completedAt ?? 0)), state: live ? 'running' : stopped ? 'aborted' : failed ? 'incomplete' : replyId ? 'completed' : unresolved ? 'unknown' : 'incomplete', fileCount: Object.keys(changes).length, incomplete: incomplete || unresolved, changes, replies: [], bindings: previous?.replyMessageId === replyId ? previous?.bindings ?? {} : {}, notice: unresolved ? '执行状态证据缺失或过期，待核验；不代表任务已结束。' : incomplete ? '从主程序历史恢复；部分证据或最终回复不可用。' : '从主程序历史证据恢复；文件模式未知，不代表当前磁盘状态。' };
        run.delegations = children.length ? children : undefined;
        if (live) run.bindings = {};
        if (duplicates.length) {
          for (const duplicate of duplicates) {
            const liveRun = (await this.store.getRun(duplicate.id))!;
            const recoveredFiles = { ...liveRun.hostRecovery?.files };
            let changed = false;
            for (const [value, change] of Object.entries(liveRun.changes)) if (foreignRecovery(liveRun, value, change) || (change.evidence ?? []).some(ref => !standardEvidence(ref))) {
              recoveredFiles[value] ??= captureCheckpoint(change); delete liveRun.changes[value]; changed = true;
            }
            if (liveRun.userMessageId !== user.id || liveRun.boundary !== 'user') {
              liveRun.userMessageId = user.id; liveRun.boundary = 'user';
              delete liveRun.replyMessageId; liveRun.bindings = {}; changed = true;
            }
            if (live && (liveRun.replyMessageId || liveRun.finalReply || Object.keys(liveRun.bindings).length)) { delete liveRun.replyMessageId; delete liveRun.finalReply; liveRun.bindings = {}; changed = true; }
            if (replyId && liveRun.replyMessageId !== replyId) { liveRun.replyMessageId = replyId; changed = true; }
            for (const [value, change] of Object.entries(changes)) {
              const old = liveRun.changes[value];
              const complete = change.before.kind === 'text' && change.after.kind === 'text';
              const covered = !!old?.evidence?.length && old.evidence.every(ref => refOwner(ref) === user.id);
              if (!old || (covered && complete) || (complete && (old.ambiguous || old.before.kind === 'unavailable' || old.after.kind === 'unavailable')) || old.evidence?.some(e => e.startsWith('native:'))) {
                const signature = (c: HistoryChange | undefined) => c && JSON.stringify({ ...c, diffStats: undefined });
                if (signature(old) !== signature(change)) {
                  recoveredFiles[value] ??= captureCheckpoint(old);
                  liveRun.changes[value] = change; changed = true;
                }
              }
            }
            if (JSON.stringify(liveRun.delegations) !== JSON.stringify(run.delegations)) { liveRun.delegations = run.delegations; changed = true; }
            if (liveRun.state !== run.state || liveRun.endedAt !== run.endedAt) { liveRun.state = run.state; liveRun.endedAt = run.endedAt; changed = true; }
            if (statusKnown && !live && liveRun.execution?.state === 'running') { liveRun.execution = { ...liveRun.execution, state: 'settled', revision: liveRun.execution.revision + 1 }; changed = true; }
            if (migrating && previous) { liveRun.bindings = { ...previous.bindings, ...liveRun.bindings }; changed = true; }
            const damaged = Object.values(liveRun.changes).some(c => c.ambiguous || c.before.kind === 'unavailable' || c.after.kind === 'unavailable');
            if (liveRun.incomplete !== (run.incomplete || damaged)) { liveRun.incomplete = run.incomplete || damaged; changed = true; }
            // Do not acknowledge an inbox version that has not actually been imported.
            // A writer may have produced complete snapshots while native recovery was scanning.
            const captureVersion = liveRun.hostRecovery?.captureVersion ?? liveRun.contentVersion ?? 0;
            if (liveRun.hostRecovery?.captureVersion !== captureVersion || JSON.stringify(liveRun.hostRecovery?.files ?? {}) !== JSON.stringify(recoveredFiles)) {
              liveRun.hostRecovery = { captureVersion, files: recoveredFiles }; changed = true;
            }
            d.runIds.push(liveRun.id);
            if (changed) { liveRun.contentVersion = (liveRun.contentVersion ?? 0) + 1; await this.store.writeRun(liveRun); d.imported++; }
            else d.unchanged++;
          }
          if (duplicates.length > 1) await this.coalesceCaptures(duplicates.map(duplicate => duplicate.id), run, refOwner);
          if (await this.store.getRun(duplicates[0].id)) await this.store.retireRun(id, duplicates[0].id);
          continue;
        }
        // Compare source-owned state only: storage may add stats/previews and strip blob text.
        const signature = (r: HostHistoryRun) => JSON.stringify({ ...r, contentVersion: undefined, cardPreview: undefined, changes: Object.fromEntries(Object.entries(r.changes).map(([p, c]) => [p, { ...c, diffStats: undefined, before: { ...c.before, text: null }, after: { ...c.after, text: null } }])) });
        d.runIds.push(id);
        if (previous && signature(previous) === signature(run)) { d.unchanged++; continue; }
        run.contentVersion = (previous?.contentVersion ?? 0) + 1;
        await this.store.writeRun(run);
        d.imported++;
      }
    });
    return d;
  }
  /** Under captureLock: merge display records only after exact USER/tool ownership proof. */
  private async coalesceCaptures(ids: string[], native: CaptureRun, refOwner: (ref: string) => string | undefined): Promise<void> {
    const primary = (await this.store.getRun(ids[0]))!;
    for (const id of ids.slice(1)) {
      const child = await this.store.getRun(id); if (!child) continue;
      for (const [value, change] of Object.entries(child.changes)) {
        if (change.evidence?.some(ref => { const owner = refOwner(ref); return owner && owner !== native.userMessageId; })) continue;
        const prior = primary.changes[value];
        if (!prior) { primary.changes[value] = change; continue; }
        const equal = (a: FileSnapshot, b: FileSnapshot) => a.hash === b.hash && a.exists === b.exists;
        if (equal(prior.before, change.before) && equal(prior.after, change.after)) continue;
        const refs = [...new Set([...(prior.evidence ?? []), ...(change.evidence ?? [])])];
        if (!prior.ambiguous && !change.ambiguous && equal(prior.after, change.before)) primary.changes[value] = { ...prior, after: change.after, diffStats: undefined, evidence: refs };
        else if (!prior.ambiguous && !change.ambiguous && equal(change.after, prior.before)) primary.changes[value] = { ...prior, before: change.before, diffStats: undefined, evidence: refs };
        else primary.changes[value] = { ...prior, ambiguous: true, diffStats: undefined, evidence: refs, note: '同轮次执行者的文件端点无法接续；不自动合并并发覆盖，差异与行数未知。' };
      }
    }
    for (const [value, change] of Object.entries(native.changes)) {
      const prior = primary.changes[value];
      const calls = new Set(prior?.evidence?.map(ref => ref.slice(ref.indexOf(':') + 1)));
      const covered = change.evidence?.every(ref => calls.has(ref.slice(ref.indexOf(':') + 1)));
      if (!prior || change.ambiguous || !covered || (change.before.kind === 'text' && change.after.kind === 'text')) primary.changes[value] = change;
    }
    primary.incomplete ||= Object.values(primary.changes).some(change => change.ambiguous || change.before.kind === 'unavailable' || change.after.kind === 'unavailable');
    primary.startedAt = native.startedAt; primary.cardPreview = undefined;
    primary.contentVersion = (primary.contentVersion ?? 0) + 1;
    await this.store.writeRun(primary);
    for (const id of ids.slice(1)) await this.store.retireRun(id, primary.id);
  }
}

/** Reconstruct only from complete before bytes + structured hunks, then require SHA-256.
 * Patch-only evidence is never converted into invented complete content or statistics.
 */
function applyReview(before: string, hunks: unknown, expected: string): string | undefined {
  if (!Array.isArray(hunks) || hunks.length > 4096) return undefined;
  const original = before === '' ? [] : before.split('\n'); if (before.endsWith('\n')) original.pop();
  const clean = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line;
  let cursor = 0; const output: string[] = [];
  for (const h of hunks) {
    if (!object(h) || typeof h.header !== 'string' || !Array.isArray(h.lines)) return undefined;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
    if (!match) return undefined;
    const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1), oldStart = Number(match[1]);
    const start = !original.length && !oldCount && oldStart <= 1 ? 0 : oldStart - (oldCount ? 1 : 0);
    if (![oldCount, newCount, start].every(Number.isSafeInteger) || start < cursor || start > original.length) return undefined;
    output.push(...original.slice(cursor, start)); cursor = start;
    let removed = 0, added = 0;
    for (const line of h.lines) {
      if (!object(line) || typeof line.text !== 'string' || line.text.includes('\n')) return undefined;
      if (line.type === 'notice' && line.text === '\\ No newline at end of file') continue;
      if (line.type === 'context' || line.type === 'del') { if (cursor >= original.length || clean(original[cursor]) !== clean(line.text)) return undefined; removed++; }
      if (line.type === 'context' || line.type === 'add') { output.push(line.type === 'context' ? original[cursor] : line.text); added++; }
      if (line.type === 'context' || line.type === 'del') cursor++;
      if (!['context', 'del', 'add'].includes(line.type)) return undefined;
    }
    if (removed !== oldCount || added !== newCount) return undefined;
  }
  output.push(...original.slice(cursor));
  // Host hunks omit CR in CRLF lines. Try bounded newline representations, accepting
  // only the exact recorded after hash (including final-newline presence).
  const variants = new Set([output.join('\n'), output.map(clean).join('\n'), output.map(clean).join('\r\n')]);
  for (const text of variants) for (const suffix of ['', '\n', '\r\n']) {
    const value = text + suffix;
    if (Buffer.byteLength(value) <= MAX_TEXT_BYTES && digest(value) === expected) return value;
  }
  return undefined;
}
