import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicHostSource } from '../../src/core/public-host-source';

const operations = ['session/get', 'agent/getStatus'].map(id => ({ id, description: id, risk: 'read' }));
const message = (id: string, createdAt = 1) => ({ id, role: 'user', createdAt, content: 'private-conversation' });
const page = (id = 's', messages: unknown[] = [message('u')], extra: Record<string, unknown> = {}) => ({
  session: { id, projectPath: '/project', messages, messageStart: 0, hasMoreBefore: false, ...extra }
});
const status = (id = 's', isRunning = true) => ({ status: { sessionId: id, isRunning, currentTurnId: 'turn-1' } });
type Call = { operation: string; args: unknown[] };
function desktop(handler: (call: Call) => unknown = call => call.operation === 'session/get' ? page(String((call.args[0] as any).id)) : status(String(call.args[0]))) {
  return { listOperations: vi.fn(async (): Promise<unknown> => operations), invoke: vi.fn(async (call: Call): Promise<unknown> => handler(call)) };
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe('public host source contract and sanitization', () => {
  it('probes first and uses only the documented args and whitelisted outputs', async () => {
    const host = desktop(), source = createPublicHostSource({ desktop: host });
    const snapshot = await source.read('s');
    expect(snapshot).toMatchObject({ sessionId: 's', root: '/project', statusKnown: true, running: true, turnId: 'turn-1', complete: true });
    expect(snapshot.warning).toBeUndefined();
    expect(host.listOperations).toHaveBeenCalledTimes(1);
    expect(host.invoke.mock.calls.map(([call]) => call)).toEqual([
      { operation: 'agent/getStatus', args: ['s'] },
      { operation: 'session/get', args: [{ id: 's', messageLimit: 100, contentLimit: 32768 }] }
    ]);
    expect(host.listOperations.mock.invocationCallOrder[0]).toBeLessThan(host.invoke.mock.invocationCallOrder[0]);
    expect(JSON.stringify(snapshot)).not.toContain('private-conversation');
    source.close();
  });

  it.each(['', '../s', 'native-pi:other', 'a_b', 'a'.repeat(81), 's\n'])('rejects invalid session id %j before any call', async id => {
    const host = desktop(), source = createPublicHostSource({ desktop: host });
    expect(await source.read(id)).toMatchObject({ statusKnown: false, complete: false, warning: 'PUBLIC_HOST_INVALID_SESSION_ID' });
    expect(host.listOperations).not.toHaveBeenCalled(); expect(host.invoke).not.toHaveBeenCalled(); source.close();
  });

  it('accepts UUID and legacy alphanumeric/hyphen session ids', async () => {
    const source = createPublicHostSource({ desktop: desktop() });
    for (const id of ['8f939a7a-e753-4e5e-8294-27c830586454', 'ABC-123', 'x'.repeat(80)]) {
      expect(await source.read(id)).toMatchObject({ sessionId: id, statusKnown: true, complete: true });
    }
    source.close();
  });

  it('fails closed for missing interface and does not use any global fallback', async () => {
    const source = createPublicHostSource();
    expect(await source.read('s')).toMatchObject({ statusKnown: false, running: false, complete: false, warning: 'PUBLIC_HOST_UNAVAILABLE' });
    source.close();
  });

  it.each([null, {}, ['session/get'], [{ id: 'session/get', risk: 'read' }]])('rejects malformed operation directory %j', async directory => {
    const host = desktop(); host.listOperations.mockResolvedValue(directory);
    const source = createPublicHostSource({ desktop: host });
    expect(await source.read('s')).toMatchObject({ statusKnown: false, warning: 'PUBLIC_HOST_DIRECTORY_FORMAT' });
    expect(host.invoke).not.toHaveBeenCalled(); source.close();
  });

  it('reports permission denial without persisting exception details', async () => {
    const host = desktop(); host.listOperations.mockRejectedValue(Object.assign(new Error('permission denied private-credentials'), { code: 'PERMISSION_DENIED' }));
    const source = createPublicHostSource({ desktop: host }), result = await source.read('s');
    expect(result).toMatchObject({ statusKnown: false, running: false, warning: 'PUBLIC_HOST_PERMISSION_DENIED' });
    expect(JSON.stringify(result)).not.toContain('private-credentials'); expect(host.invoke).not.toHaveBeenCalled(); source.close();
  });

  it('does not call absent or non-read operations but preserves the available half', async () => {
    const host = desktop(); host.listOperations.mockResolvedValue([{ ...operations[1], risk: 'dangerous' }, operations[0], { id: 'fs/read', description: 'not allowed', risk: 'read' }]);
    const source = createPublicHostSource({ desktop: host }), result = await source.read('s');
    expect(result).toMatchObject({ statusKnown: false, complete: true, warning: 'PUBLIC_HOST_STATUS_OPERATION_MISSING' });
    expect(result.messages).toHaveLength(1); expect(host.invoke).toHaveBeenCalledTimes(1);
    host.listOperations.mockResolvedValue([]); source.invalidate();
    expect(await source.read('s')).toMatchObject({ statusKnown: false, complete: false });
    expect(host.invoke).toHaveBeenCalledTimes(1); source.close();
  });

  it.each([{}, { status: {} }, { status: { sessionId: 's', isRunning: 'false' } }, { status: { sessionId: 's', isRunning: false, currentTurnId: {} } }])('never interprets malformed status as known idle: %j', async value => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'agent/getStatus' ? value : page()) });
    const result = await source.read('s');
    expect(result.statusKnown).toBe(false); expect(result.warning).toMatch(/STATUS_/); expect(result.messages).toHaveLength(1); source.close();
  });

  it('recognizes an explicit idle status, including the official no-runtime response', async () => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'agent/getStatus' ? { status: { sessionId: 's', isRunning: false, pendingToolConfirmations: 0 } } : page()) });
    expect(await source.read('s')).toMatchObject({ statusKnown: true, running: false, complete: true }); source.close();
  });

  it.each(['wrong', undefined])('rejects wrong or missing response identities (%j), independently', async id => {
    const host = desktop(call => call.operation === 'agent/getStatus' ? { status: { sessionId: id, isRunning: true } } : { session: { ...page().session, id } });
    const source = createPublicHostSource({ desktop: host }), result = await source.read('s');
    expect(result).toMatchObject({ statusKnown: false, messages: [], complete: false });
    expect(result.warning).toContain('STATUS_IDENTITY_MISMATCH'); expect(result.warning).toContain('SESSION_IDENTITY_MISMATCH');
    expect(host.invoke.mock.calls.every(([call]) => call.args[0] === 's' || (call.args[0] as any).id === 's')).toBe(true); source.close();
  });

  it.each(['agent/getStatus', 'session/get'])('retains partial success when %s fails', async failed => {
    const source = createPublicHostSource({ desktop: desktop(call => {
      if (call.operation === failed) throw new Error('transport private-error');
      return call.operation === 'session/get' ? page() : status();
    }) });
    const result = await source.read('s');
    expect(result.statusKnown).toBe(failed !== 'agent/getStatus');
    expect(result.messages.length).toBe(failed === 'session/get' ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain('private-error'); source.close();
  });

  it('strips prose, credentials, thinking, commands, stdout and protected-path tools before caching', async () => {
    const raw = [message('u'), { id: 'a', role: 'assistant', content: 'private-answer', thinking: 'private-thinking', credentials: 'private-token' },
      { id: 'bash', role: 'tool', toolCallId: 'c1', toolName: 'Bash', toolArgs: { command: 'private-command' }, toolResult: { content: 'private-stdout', credentials: 'private-token' } },
      ...['.env', '.ssh/id_rsa', 'C:/Users/me/.pi-desktop/data/sessions/a.json', 'safe/../secret'].map((path, i) => ({ id: `denied-${i}`, role: 'tool', toolCallId: `denied-call-${i}`, toolName: 'Write', toolArgs: { path, content: 'private-file-secret' } })),
      { id: 'edit', role: 'tool', toolCallId: 'edit-call', toolName: 'Edit', toolArgs: { path: 'a.txt', old_string: 'old', new_string: 'new', credentials: 'private-token' }, toolResult: { details: { review: { path: 'a.txt', hunks: ['patch'], credentials: 'private-token' } } } }
    ];
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', raw) : status()) });
    const result = await source.read('s'), text = JSON.stringify(result);
    expect(text).not.toMatch(/private-/); expect(result.messages[1].blocks).toEqual([{ type: 'text' }]);
    expect(result.messages.filter(row => row.id.startsWith('denied')).every(row => row.blocks.length === 0)).toBe(true);
    expect(result.messages.at(-1)?.blocks[0].args).toEqual({ path: 'a.txt', old_string: 'old', new_string: 'new' });
    (raw[0] as ReturnType<typeof message>).content = 'late-private-mutated';
    expect(JSON.stringify(await source.read('s'))).not.toContain('late-private-mutated'); source.close();
  });

  it.each(['/project', 'C:\\work\\project', 'D:/work/project'])('accepts public absolute project path %j', async root => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', [], { projectPath: root }) : status()) });
    expect((await source.read('s')).root).toBe(root); source.close();
  });
  it.each(['relative/project', 'C:relative', '//server/share', '/tmp/../secret', '/home/me/.ssh', 'C:/data/.pi-desktop/config', '/tmp/project\0'])('omits unsafe project path %j', async root => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', [], { projectPath: root }) : status()) });
    expect(await source.read('s')).toMatchObject({ root: undefined, complete: false, warning: 'PUBLIC_HOST_PROJECT_PATH_REJECTED' }); source.close();
  });
});

describe('bounded physical pagination', () => {
  it('supports nested/outer pagination and preserves host order rather than timestamp order', async () => {
    const host = desktop(call => {
      if (call.operation === 'agent/getStatus') return status();
      const before = (call.args[0] as any).messageBefore;
      if (before === undefined) return page('s', [message('latest-a', 1), message('latest-b', 0)], { messageStart: 40, hasMoreBefore: true });
      if (before === 40) return { session: { id: 's', messages: [message('middle', 100)] }, messageStart: 7, messageEnd: 40, hasMoreBefore: true, hasMoreAfter: true };
      return page('s', [message('oldest-b', 99), message('oldest-a', 33)], { messageStart: 0, messageEnd: 7, hasMoreAfter: true });
    });
    const source = createPublicHostSource({ desktop: host }), result = await source.read('s');
    expect(result.complete).toBe(true);
    expect(result.messages.map(row => row.id)).toEqual(['oldest-b', 'oldest-a', 'middle', 'latest-a', 'latest-b']);
    expect(host.invoke.mock.calls.filter(([call]) => call.operation === 'session/get').map(([call]) => (call.args[0] as any).messageBefore)).toEqual([undefined, 40, 7]); source.close();
  });

  it.each([40, 41, -1, 0.5, undefined])('rejects nondecreasing/invalid physical start %j without merging the bad page', async nextStart => {
    let n = 0;
    const host = desktop(call => call.operation === 'agent/getStatus' ? status() : ++n === 1
      ? page('s', [message('latest')], { messageStart: 40, hasMoreBefore: true })
      : page('s', [message('bad-page')], { messageStart: nextStart, hasMoreBefore: true }));
    const source = createPublicHostSource({ desktop: host }), result = await source.read('s');
    expect(result.complete).toBe(false); expect(result.warning).toContain('PAGINATION_CURSOR');
    expect(result.messages.map(row => row.id)).toEqual(['latest']); expect(n).toBe(2); source.close();
  });

  it.each([
    { messageStart: undefined, hasMoreBefore: undefined }, { messageStart: 3, hasMoreBefore: false },
    { messageStart: 0, hasMoreBefore: true }, { messageStart: 0, hasMoreAfter: true }, { messageEnd: -1 }
  ])('does not claim completeness for inconsistent/missing pagination %j', async metadata => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', [message('u')], metadata) : status()) });
    expect(await source.read('s')).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_PAGINATION_INCOMPLETE' }); source.close();
  });

  it('rejects conflicting nested/outer cursors', async () => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? { ...page(), messageStart: 1 } : status()) });
    expect(await source.read('s')).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_PAGINATION_CURSOR' }); source.close();
  });

  it('keeps prior pages when a subsequent page belongs to another session', async () => {
    let n = 0;
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'agent/getStatus' ? status() : ++n === 1
      ? page('s', [message('latest')], { messageStart: 1, hasMoreBefore: true }) : page('other', [message('foreign')])) });
    const result = await source.read('s'); expect(result.messages.map(row => row.id)).toEqual(['latest']);
    expect(result).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_SESSION_IDENTITY_MISMATCH' }); source.close();
  });

  it('detects official display-truncation markers even in removed conversational content', async () => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', [{ ...message('u'), content: 'private-body\n\n[truncated for display; the full content remains in the transcript]' }]) : status()) });
    const result = await source.read('s'); expect(result).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_TRANSCRIPT_TRUNCATED' });
    expect(JSON.stringify(result)).not.toContain('private-body'); source.close();
  });

  it('stops at 20 pages / 2000 messages even when the host advertises more', async () => {
    let n = 0;
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'agent/getStatus' ? status() : page('s', Array.from({ length: 100 }, (_, i) => message(`${n}-${i}`)), { messageStart: 3000 - ++n * 100, hasMoreBefore: true })) });
    const result = await source.read('s'); expect(n).toBe(20); expect(result.messages).toHaveLength(2000);
    expect(result).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_PAGE_LIMIT' }); source.close();
  });

  it('caps messages even if the host ignores messageLimit', async () => {
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', Array.from({ length: 2100 }, (_, i) => message(`m-${i}`))) : status()) });
    const result = await source.read('s'); expect(result.messages).toHaveLength(2000);
    expect(result).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_EVIDENCE_LIMIT' }); source.close();
  });

  it('bounds UTF-8 evidence at 8 MiB, never raw conversational length', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `write-${i}`, role: 'tool', toolCallId: `call-${i}`, toolName: 'Write', toolArgs: { path: 'a.txt', content: '中'.repeat(32700) } }));
    const source = createPublicHostSource({ desktop: desktop(call => call.operation === 'session/get' ? page('s', rows) : status()) });
    const result = await source.read('s'); expect(result.messages.length).toBeGreaterThan(1); expect(result.messages.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result).toMatchObject({ complete: false, warning: 'PUBLIC_HOST_EVIDENCE_LIMIT' }); source.close();
  });
});

describe('lifetime, singleflight, bounded cache and concurrency', () => {
  it('singleflights per session and expires at the default 1000ms TTL', async () => {
    let time = 100;
    const host = desktop(), source = createPublicHostSource({ desktop: host, now: () => time });
    const first = source.read('s'); expect(source.read('s')).toBe(first); await first;
    time = 1099; expect(source.read('s')).toBe(first); expect(host.invoke).toHaveBeenCalledTimes(2);
    time = 1100; const next = source.read('s'); expect(next).not.toBe(first); await next;
    expect(host.invoke).toHaveBeenCalledTimes(4); source.close();
  });

  it('evicts the least recently used completed session at capacity 32', async () => {
    const host = desktop(), source = createPublicHostSource({ desktop: host, ttlMs: 100000 });
    for (let i = 0; i < 32; i++) await source.read(`s-${i}`);
    await source.read('s-0'); await source.read('s-32');
    const count = host.listOperations.mock.calls.length;
    await source.read('s-0'); expect(host.listOperations).toHaveBeenCalledTimes(count);
    await source.read('s-1'); expect(host.listOperations).toHaveBeenCalledTimes(count + 1); source.close();
  });

  it('bounds pending sessions and all actual host concurrency including directory probes', async () => {
    vi.useFakeTimers();
    let active = 0, peak = 0;
    const run = async (value: unknown) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return value; };
    const host = { listOperations: vi.fn(() => run(operations)), invoke: vi.fn((call: Call) => run(call.operation === 'session/get' ? page((call.args[0] as any).id) : status(String(call.args[0])))) };
    const source = createPublicHostSource({ desktop: host });
    const pending = Array.from({ length: 32 }, (_, i) => source.read(`s-${i}`));
    expect(await source.read('overflow')).toMatchObject({ warning: 'PUBLIC_HOST_CAPACITY', statusKnown: false });
    await vi.runAllTimersAsync();
    expect((await Promise.all(pending)).every(row => row.complete && row.statusKnown)).toBe(true);
    expect(peak).toBe(2); expect(host.invoke).toHaveBeenCalledTimes(64); source.close();
  });

  it('times out directory probes at 1500ms and settles queued readers too', async () => {
    vi.useFakeTimers();
    const gates = [deferred(), deferred()]; let n = 0;
    const host = desktop(); host.listOperations.mockImplementation(() => gates[n++].promise);
    const source = createPublicHostSource({ desktop: host });
    const reads = ['a', 'b', 'c'].map(id => source.read(id)); await flush();
    await vi.advanceTimersByTimeAsync(1499); let done = false; void reads[0].then(() => { done = true; }); await flush(); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (const result of await Promise.all(reads)) expect(result).toMatchObject({ warning: 'PUBLIC_HOST_TIMEOUT', statusKnown: false });
    expect(host.listOperations).toHaveBeenCalledTimes(2); expect(host.invoke).not.toHaveBeenCalled();
    source.close(); gates.forEach(gate => gate.resolve(operations)); await flush(); expect(host.invoke).not.toHaveBeenCalled();
  });

  it('keeps successful evidence on status timeout, ignores late status and permits a fresh read', async () => {
    vi.useFakeTimers();
    const late = deferred(); let attempt = 0;
    const host = desktop(call => call.operation === 'session/get' ? page() : ++attempt === 1 ? late.promise : status('s', false));
    const source = createPublicHostSource({ desktop: host, timeoutMs: 10 });
    const pending = source.read('s'); await flush(); await vi.advanceTimersByTimeAsync(10);
    const result = await pending; expect(result.messages).toHaveLength(1); expect(result).toMatchObject({ statusKnown: false, warning: 'PUBLIC_HOST_TIMEOUT', complete: false });
    late.resolve(status()); await flush(); expect(result.statusKnown).toBe(false);
    expect(await source.read('s')).toMatchObject({ statusKnown: true, running: false }); expect(attempt).toBe(2); source.close();
  });

  it('does not release timed-out actual invoke slots and exceed concurrency on retries', async () => {
    vi.useFakeTimers();
    const gates = [deferred(), deferred()]; let n = 0;
    const host = desktop(() => gates[n++].promise), source = createPublicHostSource({ desktop: host, timeoutMs: 10 });
    const first = source.read('s'); await flush(); await vi.advanceTimersByTimeAsync(10); await first;
    const second = source.read('s'); await flush(); await vi.advanceTimersByTimeAsync(10);
    expect(await second).toMatchObject({ warning: 'PUBLIC_HOST_TIMEOUT' }); expect(host.invoke).toHaveBeenCalledTimes(2); expect(host.listOperations).toHaveBeenCalledTimes(1);
    source.close(); gates.forEach(gate => gate.resolve({})); await flush();
  });

  it('close settles inflight and queued reads immediately, and late results cannot revive them', async () => {
    const gate = deferred(); const host = desktop(() => gate.promise), source = createPublicHostSource({ desktop: host });
    const first = source.read('s'); await flush(); const queued = source.read('other'); source.close(); source.close();
    expect(await first).toMatchObject({ warning: 'PUBLIC_HOST_CLOSED', complete: false });
    expect(await queued).toMatchObject({ warning: 'PUBLIC_HOST_CLOSED' });
    gate.resolve(page()); await flush();
    expect(await source.read('s')).toMatchObject({ warning: 'PUBLIC_HOST_CLOSED', statusKnown: false }); expect(host.invoke).toHaveBeenCalledTimes(2);
  });

  it('invalidate rejects late old results without deleting the new same-session generation', async () => {
    const late = deferred(); let attempt = 0;
    const host = desktop(call => call.operation === 'session/get' ? ++attempt === 1 ? late.promise : page('s', [message('new')]) : status());
    const source = createPublicHostSource({ desktop: host });
    const old = source.read('s'); await flush(); source.invalidate('unrelated'); expect(source.read('s')).toBe(old);
    source.invalidate('s'); expect(await old).toMatchObject({ warning: 'PUBLIC_HOST_INVALIDATED', complete: false });
    const next = source.read('s'); expect((await next).messages[0].id).toBe('new');
    late.resolve(page('s', [message('old')])); await flush();
    expect(source.read('s')).toBe(next); expect((await source.read('s')).messages[0].id).toBe('new');
    source.invalidate(); const newest = source.read('s'); expect(newest).not.toBe(next); await newest; source.close();
  });
});
