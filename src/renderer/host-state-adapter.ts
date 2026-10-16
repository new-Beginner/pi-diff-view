export class PluginReviewError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export interface RunningActivity { sessionId: string; taskId: string; since: number; turnId?: string }
export interface SessionContext { sessionId: string; root?: string; running: boolean; mainRunning?: boolean; statusKnown?: boolean; taskId?: string; since?: number; turnId?: string; evidence?: string; evidenceRevision?: string }
/** Derive activity only from public, backend-normalized task metadata. */
export function runningActivity(context?: SessionContext): RunningActivity | null {
  if (!context?.sessionId || !context.running || context.statusKnown === false) return null;
  const { sessionId, taskId, since, turnId } = context;
  if (typeof taskId === 'string' && taskId.trim() && typeof since === 'number' && Number.isSafeInteger(since) && since > 0 && since <= Date.now()) return { sessionId, taskId, since, ...(turnId ? { turnId } : {}) };
  if (typeof turnId === 'string' && turnId.trim() && (since === undefined || since === 0)) return { sessionId, taskId: `turn:${turnId}`, since: 0, turnId };
  return null;
}
export function activityDiagnostic(context?: SessionContext): 'running-idle' | 'running-identity-missing' | 'running-ready' {
  if (!context) return 'running-idle';
  if (context.statusKnown === false) return 'running-identity-missing';
  return runningActivity(context) ? 'running-ready' : context.running ? 'running-identity-missing' : 'running-idle';
}
const unknownContext = (sessionId: string): SessionContext => ({ sessionId, running: false, statusKnown: false });
/** One public polling source shared by evidence and activity subscribers. */
export function createHostStateAdapter(options: {
  read(sessionId: string): Promise<SessionContext>;
  session(): string | null;
  observe?(callback: () => void): { disconnect(): void };
}) {
  type Subscriber = { publish(): void };
  const subscribers = new Set<Subscriber>();
  let closed = false, started = false, generation = 0;
  let sessionId: string | null | undefined, context: SessionContext | undefined;
  let observer: { disconnect(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  const alive = () => { if (closed) throw new PluginReviewError('SIDEBAR_UNLOADED', '插件已卸载 / Plugin unloaded'); };
  const publish = () => { for (const subscriber of [...subscribers]) if (subscribers.has(subscriber)) subscriber.publish(); };
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => { cancelTimer(); timer = setTimeout(() => { timer = undefined; poll(); }, 1000); };
  const syncSession = () => {
    const next = options.session();
    if (next === sessionId) return false;
    sessionId = next; generation++; cancelTimer();
    context = next ? unknownContext(next) : undefined;
    publish();
    return true;
  };
  const poll = () => {
    if (closed || !started) return;
    syncSession();
    if (closed || !started) return;
    schedule();
    if (flight || !sessionId) return;
    const id = sessionId, version = generation;
    // Defer read so synchronous exceptions also become unknown state.
    flight = Promise.resolve().then(() => !closed && started && generation === version ? options.read(id) : undefined).then(result => {
      if (closed || !started) return;
      syncSession();
      if (generation !== version) return;
      if (!result || result.sessionId !== id || typeof result.running !== 'boolean' || typeof result.statusKnown !== 'boolean') {
        context = unknownContext(id);
      } else {
        // Explicit allowlist: transcript/evidence strings must never enter the renderer source.
        context = { sessionId: id, root: result.root, running: result.running, mainRunning: result.mainRunning, statusKnown: result.statusKnown, taskId: result.taskId, since: result.since, turnId: result.turnId, evidenceRevision: result.evidenceRevision };
      }
      publish();
    }, () => {
      if (closed || !started) return;
      syncSession();
      if (generation !== version) return;
      context = unknownContext(id); publish();
    }).finally(() => {
      flight = undefined;
      if (closed || !started) return;
      syncSession();
      if (generation !== version) poll();
      else schedule();
    });
  };
  const stop = () => {
    started = false; generation++; cancelTimer(); observer?.disconnect(); observer = undefined;
    sessionId = undefined; context = undefined;
  };
  const subscribe = (subscriber: Subscriber) => {
    alive(); subscribers.add(subscriber);
    try {
      if (!started) {
        started = true; syncSession();
        alive();
        observer = options.observe?.(() => { if (started && !closed && syncSession()) poll(); });
        poll();
      } else { if (syncSession()) poll(); if (!closed && started) subscriber.publish(); }
    } catch (error) { subscribers.delete(subscriber); if (!subscribers.size) stop(); throw error; }
    let stopped = false;
    return () => { if (stopped) return; stopped = true; subscribers.delete(subscriber); if (!subscribers.size) stop(); };
  };
  return {
    async subscribeEvidence(listener: (sessionId: string | null, context?: SessionContext) => void): Promise<() => void> {
      let previous: string | undefined;
      return subscribe({ publish() {
        const key = JSON.stringify([generation, sessionId, context]);
        if (key !== previous) { previous = key; listener(sessionId ?? null, context); }
      } });
    },
    async subscribeActivity(listener: (activity: RunningActivity | null) => void, diagnose?: (stage: string) => void): Promise<() => void> {
      let previous: string | undefined;
      return subscribe({ publish() {
        const activity = runningActivity(context), diagnostic = activityDiagnostic(context);
        const key = JSON.stringify([generation, activity, diagnostic]);
        if (key !== previous) { previous = key; diagnose?.(diagnostic); listener(activity); }
      } });
    },
    close() { if (closed) return; closed = true; stop(); subscribers.clear(); }
  };
}
