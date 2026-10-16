import { hostEvidenceMessages, type HostEvidenceMessage } from './host-transcript';
import { assertPublicPath, assertSessionScratchPath } from './public-path';

export interface PublicHostSnapshot {
  sessionId: string;
  root?: string;
  statusKnown: boolean;
  running: boolean;
  turnId?: string;
  messages: HostEvidenceMessage[];
  /** Whether the transcript evidence is complete; status has its own statusKnown bit. */
  complete: boolean;
  warning?: string;
}
interface Desktop {
  listOperations(): Promise<unknown>;
  invoke(input: { operation: string; args: unknown[] }): Promise<unknown>;
}
interface Entry {
  promise: Promise<PublicHostSnapshot>;
  snapshot: PublicHostSnapshot;
  done: boolean;
  expires: number;
  finish(warning?: string, cache?: boolean): void;
}
interface Queued { entry: Entry; start(): void; cancel(): void }
const sessionIdPattern = /^[a-zA-Z0-9-]{1,80}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\0\r\n]/.test(v);
function empty(sessionId: string, warning?: string): PublicHostSnapshot {
  return { sessionId, statusKnown: false, running: false, messages: [], complete: false, ...(warning ? { warning } : {}) };
}
function warn(snapshot: PublicHostSnapshot, warning: string): void {
  const warnings = new Set(snapshot.warning?.split('; ') ?? []);
  warnings.add(warning); snapshot.warning = [...warnings].join('; ');
}
function failure(error: unknown, operation: string): string {
  // Classify, but never retain host exceptions, paths, credentials or error details.
  const code = record(error) ? error.code ?? error.errorCode : undefined;
  const message = error instanceof Error ? error.message : '';
  return /denied|permission|forbidden|consent|权限/i.test(`${typeof code === 'string' ? code : ''} ${message}`)
    ? 'PUBLIC_HOST_PERMISSION_DENIED' : `PUBLIC_HOST_${operation}_FAILED`;
}
function projectRoot(value: unknown, sessionId: string): string | undefined {
  if (typeof value !== 'string' || !/^(?:[a-z]:[\\/]|\/)/i.test(value)) return undefined;
  try { assertPublicPath(value); assertSessionScratchPath(value, sessionId, value); return value; } catch { return undefined; }
}
function truncated(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('[truncated for display');
  if (!value || typeof value !== 'object') return false;
  if (depth > 32) return true;
  if (record(value) && (value.truncated === true || value._truncated === true || value.contentTruncated === true)) return true;
  return Object.values(value).some(child => truncated(child, depth + 1));
}
// Contracts verified at vastsa/PI-Desktop@a7a98ee051b1b35eb959830eabe0cebca3e39215:
// plugin-sdk/src/index.ts:958-968,1173-1175; desktop/main/mcp-control.ts:206-210;
// desktop/main/ipc/session-ipc.ts:254-294; agent-runtime/src/sidecar.ts:589-601.
// Both response identities are mandatory. Pagination can be nested or outer.
export function createPublicHostSource(options: {
  desktop?: Desktop; now?: () => number; timeoutMs?: number; ttlMs?: number;
} = {}) {
  const desktop = options.desktop, now = options.now ?? Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs!) : 1500;
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs!) : 1000;
  const entries = new Map<string, Entry>(), queue: Queued[] = [];
  let closed = false, active = 0;
  function drain(): void {
    while (!closed && active < 2 && queue.length) {
      const next = queue.shift()!;
      if (next.entry.done) next.cancel(); else next.start();
    }
  }
  function discard(entry: Entry): void {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].entry === entry) queue.splice(i, 1)[0].cancel();
  }
  function request(entry: Entry, call: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const canceled = () => reject(new Error('PUBLIC_HOST_CANCELED'));
      if (closed || entry.done) { canceled(); return; }
      queue.push({ entry, cancel: canceled, start() {
        active++;
        // Hold the actual slot even after a caller times out: invoke has no abort API.
        // Thus a hung host cannot cause an unbounded number of real invocations.
        Promise.resolve().then(() => {
          if (closed || entry.done) throw new Error('PUBLIC_HOST_CANCELED');
          return call();
        }).then(resolve, reject).finally(() => { active--; drain(); });
      } });
      drain();
    });
  }
  async function status(entry: Entry): Promise<void> {
    const snapshot = entry.snapshot;
    try {
      const value = await request(entry, () => desktop!.invoke({ operation: 'agent/getStatus', args: [snapshot.sessionId] }));
      if (entry.done) return;
      if (!record(value) || !record(value.status)) { warn(snapshot, 'PUBLIC_HOST_STATUS_FORMAT'); return; }
      const row = value.status;
      if (row.sessionId !== snapshot.sessionId) { warn(snapshot, 'PUBLIC_HOST_STATUS_IDENTITY_MISMATCH'); return; }
      if (typeof row.isRunning !== 'boolean' || (row.currentTurnId != null && !identity(row.currentTurnId))) {
        warn(snapshot, 'PUBLIC_HOST_STATUS_FORMAT'); return;
      }
      snapshot.statusKnown = true; snapshot.running = row.isRunning;
      if (identity(row.currentTurnId)) snapshot.turnId = row.currentTurnId;
    } catch (error) { if (!entry.done) warn(snapshot, failure(error, 'STATUS')); }
  }
  async function transcript(entry: Entry): Promise<void> {
    const snapshot = entry.snapshot;
    let before: number | undefined, bytes = 2, count = 0, damaged = false;
    const encoder = new TextEncoder();
    for (let page = 0; page < 20 && !entry.done; page++) {
      try {
        const value = await request(entry, () => desktop!.invoke({ operation: 'session/get', args: [{
          id: snapshot.sessionId, messageLimit: 100, contentLimit: 32768,
          ...(before === undefined ? {} : { messageBefore: before })
        }] }));
        if (entry.done) return;
        if (!record(value) || !record(value.session)) { warn(snapshot, 'PUBLIC_HOST_SESSION_FORMAT'); return; }
        const session = value.session;
        if (session.id !== snapshot.sessionId) { warn(snapshot, 'PUBLIC_HOST_SESSION_IDENTITY_MISMATCH'); return; }
        if (!Array.isArray(session.messages)) { warn(snapshot, 'PUBLIC_HOST_SESSION_FORMAT'); return; }
        const field = (key: string): unknown => session[key] ?? value[key];
        const start = field('messageStart'), more = field('hasMoreBefore'), end = field('messageEnd');
        const conflicts = ['messageStart', 'hasMoreBefore', 'messageEnd', 'hasMoreAfter'].some(key =>
          session[key] !== undefined && value[key] !== undefined && session[key] !== value[key]);
        if (conflicts || (before !== undefined && (!integer(start) || start >= before || (end !== undefined && end !== before)))) {
          warn(snapshot, 'PUBLIC_HOST_PAGINATION_CURSOR'); return;
        }
        if (page === 0 && session.projectPath != null) {
          snapshot.root = projectRoot(session.projectPath, snapshot.sessionId);
          if (!snapshot.root) { warn(snapshot, 'PUBLIC_HOST_PROJECT_PATH_REJECTED'); damaged = true; }
        }
        const rows: HostEvidenceMessage[] = [];
        if (truncated(session) || value.truncated === true || value._truncated === true) {
          warn(snapshot, 'PUBLIC_HOST_TRANSCRIPT_TRUNCATED'); damaged = true;
        }
        let limited = false;
        for (const raw of session.messages) {
          if (++count > 2000) { limited = true; break; }
          try {
            if (!record(raw) || !identity(raw.id) || !['user', 'assistant', 'tool', 'system'].includes(raw.role)
              || (raw.sessionId !== undefined && raw.sessionId !== snapshot.sessionId)) throw new Error();
            const normalized = hostEvidenceMessages([raw], snapshot.root ? snapshot.sessionId : undefined, snapshot.root)[0];
            if (!normalized || (typeof normalized.createdAt !== 'string' && typeof normalized.createdAt !== 'number' && normalized.createdAt !== undefined)
              || Object.values(normalized.meta).some(v => v !== undefined && !['string', 'boolean', 'number'].includes(typeof v))
              || normalized.blocks.some(b => (b.status !== undefined && typeof b.status !== 'string')
                || (b.result?.isError !== undefined && typeof b.result.isError !== 'boolean'))) throw new Error();
            // Serialize ONLY the whitelist DTO, never the conversational transcript.
            // Detaching also prevents the host mutating cached object references.
            const text = JSON.stringify(normalized), size = encoder.encode(text).length + 1;
            if (bytes + size > MAX_BYTES) { limited = true; break; }
            bytes += size; rows.push(JSON.parse(text) as HostEvidenceMessage);
          } catch { warn(snapshot, 'PUBLIC_HOST_MESSAGE_FORMAT'); damaged = true; }
        }
        snapshot.messages = [...rows, ...snapshot.messages];
        if (limited) { warn(snapshot, 'PUBLIC_HOST_EVIDENCE_LIMIT'); return; }
        if (!integer(start) || typeof more !== 'boolean' || (end !== undefined && (!integer(end) || end < start))
          || (more && start === 0) || (!more && start !== 0)
          || (field('hasMoreAfter') !== undefined && typeof field('hasMoreAfter') !== 'boolean')
          || (page === 0 && field('hasMoreAfter') === true)) {
          warn(snapshot, 'PUBLIC_HOST_PAGINATION_INCOMPLETE'); return;
        }
        if (!more) { snapshot.complete = !damaged; return; }
        if (count >= 2000 || page === 19) { warn(snapshot, 'PUBLIC_HOST_PAGE_LIMIT'); return; }
        before = start;
      } catch (error) { if (!entry.done) warn(snapshot, failure(error, 'SESSION')); return; }
    }
  }
  async function load(entry: Entry): Promise<void> {
    try {
      if (!desktop || typeof desktop.listOperations !== 'function' || typeof desktop.invoke !== 'function') {
        entry.finish('PUBLIC_HOST_UNAVAILABLE'); return;
      }
      const directory = await request(entry, () => desktop.listOperations());
      if (entry.done) return;
      if (!Array.isArray(directory) || !directory.every(row => record(row) && typeof row.id === 'string'
        && typeof row.description === 'string' && ['read', 'write', 'dangerous'].includes(row.risk))) {
        entry.finish('PUBLIC_HOST_DIRECTORY_FORMAT'); return;
      }
      const operations = new Set(directory.filter(row => row.risk === 'read').map(row => row.id));
      const work: Promise<void>[] = [];
      if (operations.has('agent/getStatus')) work.push(status(entry));
      else warn(entry.snapshot, 'PUBLIC_HOST_STATUS_OPERATION_MISSING');
      if (operations.has('session/get')) work.push(transcript(entry));
      else warn(entry.snapshot, 'PUBLIC_HOST_SESSION_OPERATION_MISSING');
      await Promise.all(work);
      if (!entry.done) entry.finish();
    } catch (error) { if (!entry.done) entry.finish(failure(error, 'DIRECTORY')); }
  }
  function read(sessionId: string): Promise<PublicHostSnapshot> {
    if (closed) return Promise.resolve(empty(sessionId, 'PUBLIC_HOST_CLOSED'));
    if (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)) return Promise.resolve(empty('', 'PUBLIC_HOST_INVALID_SESSION_ID'));
    const cached = entries.get(sessionId);
    if (cached && (!cached.done || cached.expires > now())) {
      entries.delete(sessionId); entries.set(sessionId, cached); return cached.promise;
    }
    if (cached) entries.delete(sessionId);
    if (entries.size >= 32) {
      const oldest = [...entries].find(([, entry]) => entry.done);
      if (oldest) entries.delete(oldest[0]);
      else return Promise.resolve(empty(sessionId, 'PUBLIC_HOST_CAPACITY'));
    }
    let resolve!: (snapshot: PublicHostSnapshot) => void;
    const promise = new Promise<PublicHostSnapshot>(done => { resolve = done; });
    const entry: Entry = { promise, snapshot: empty(sessionId), done: false, expires: 0, finish(warning, cache = true) {
      if (entry.done) return;
      entry.done = true; clearTimeout(timer); discard(entry);
      if (warning) { warn(entry.snapshot, warning); entry.snapshot.complete = false; }
      if (!cache || closed) { if (entries.get(sessionId) === entry) entries.delete(sessionId); }
      else entry.expires = now() + ttlMs;
      resolve(entry.snapshot);
    } };
    const timer = setTimeout(() => entry.finish('PUBLIC_HOST_TIMEOUT', false), timeoutMs);
    entries.set(sessionId, entry);
    void load(entry);
    return promise;
  }
  return {
    read,
    invalidate(sessionId?: string): void {
      for (const [id, entry] of entries) if (sessionId === undefined || id === sessionId) {
        entries.delete(id); entry.finish('PUBLIC_HOST_INVALIDATED', false);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) entry.finish('PUBLIC_HOST_CLOSED', false);
      entries.clear();
    }
  };
}
