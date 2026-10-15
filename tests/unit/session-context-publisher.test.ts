import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionContextPublisher } from '../../src/renderer/session-context-publisher';
import type { UiTransport } from '../../src/core/contracts';
import type { SessionContext } from '../../src/renderer/plugin-review-adapter';
import { HostEvidenceBuffer } from '../../src/core/host-evidence-buffer';
import { evidenceRevision } from '../../src/core/host-transcript';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const base: SessionContext = { sessionId: 'a', root: '/project', running: false, evidence: '[]', evidenceRevision: 'v1' };
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(handle: (method: string, args: any) => Promise<unknown> = async () => ({ ok: true })) {
  const invoke = vi.fn(handle), wake = vi.fn(), report = vi.fn();
  let alive = true;
  const publisher = createSessionContextPublisher({ transport: { invoke: invoke as UiTransport['invoke'] }, isCurrent: () => alive, wake, report });
  return { ...publisher, invoke, wake, report, invalidate: () => { alive = false; }, calls: (method: string) => invoke.mock.calls.filter(([name]) => name === method).map(([, args]) => args) };
}

it('restarts a failed partial upload at index zero and wakes only after context succeeds', async () => {
  let failed = false;
  const buffer = new HostEvidenceBuffer();
  const evidence = JSON.stringify([{ type: 'message', id: 'large', text: 'x'.repeat(50000) }]);
  const app = setup(async (method, args) => {
    if (method === 'sessionEvidence') {
      buffer.append(args);
      // The server received this chunk, but its acknowledgement was lost.
      if (args.index === 1 && !failed) { failed = true; throw new Error('lost chunk acknowledgement'); }
    }
    return { ok: true };
  });
  app.update('a', { ...base, evidence, evidenceRevision: evidenceRevision(evidence) }); await flush();
  expect(app.calls('sessionEvidence').map(args => args.index)).toEqual([0, 1]);
  expect(app.calls('sessionContext')).toHaveLength(0); expect(app.wake).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(499); expect(app.calls('sessionEvidence')).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(app.calls('sessionEvidence').map(args => args.index)).toEqual([0, 1, 0, 1, 2]);
  expect(app.calls('sessionEvidence').map(args => args.final)).toEqual([false, false, false, false, true]);
  expect(app.calls('sessionContext')).toHaveLength(1); expect(app.wake).toHaveBeenCalledTimes(1);
  expect(buffer.messages('a', '/project')).toEqual(JSON.parse(evidence));
});

it.each(['reject', 'not-ok'])('retries context %s without resending confirmed evidence', async failure => {
  let failed = false;
  const app = setup(async method => {
    if (method === 'sessionContext' && !failed) {
      failed = true;
      if (failure === 'reject') throw new Error('context unavailable');
      return { ok: false };
    }
    return { ok: true };
  });
  app.update('a', base); await flush();
  expect(app.wake).not.toHaveBeenCalled(); expect(app.report).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(app.calls('sessionEvidence')).toHaveLength(1); expect(app.calls('sessionContext')).toHaveLength(2);
  expect(app.calls('sessionContext')[1]).not.toHaveProperty('evidence');
  expect(app.wake).toHaveBeenCalledTimes(1);
  app.update('a', { ...base, running: true }); await flush();
  expect(app.calls('sessionEvidence')).toHaveLength(1); expect(app.calls('sessionContext').at(-1).running).toBe(true);
});

it('bounds retry delays and attempts, then recovers on a new context', async () => {
  let offline = true;
  const app = setup(async () => { if (offline) throw new Error('offline'); return { ok: true }; });
  app.update('a', base); await flush();
  for (const [index, delay] of [500, 1000, 2000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1); expect(app.invoke).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1); expect(app.invoke).toHaveBeenCalledTimes(index + 2);
  }
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000); expect(app.invoke).toHaveBeenCalledTimes(4);
  expect(app.wake).not.toHaveBeenCalled();
  offline = false; app.update('a', { ...base, running: true }); await flush();
  expect(app.calls('sessionContext').at(-1).running).toBe(true); expect(app.wake).toHaveBeenCalledTimes(1);
});

it('replaces an obsolete backoff context immediately and cancels its retry', async () => {
  const app = setup(async (method, args) => { if (method === 'sessionEvidence' && args.revision === 'v1') throw new Error('old failed'); return { ok: true }; });
  app.update('a', base); await flush(); expect(vi.getTimerCount()).toBe(1);
  app.update('a', { ...base, evidenceRevision: 'v2', evidence: '[2]', running: true }); await flush();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(app.calls('sessionEvidence').map(args => args.revision)).toEqual(['v1', 'v2']);
  expect(app.calls('sessionContext').map(args => args.evidenceRevision)).toEqual(['v2']);
});

it('coalesces updates during an RPC and drops the remaining obsolete chunks', async () => {
  const first = deferred();
  const app = setup(async (method, args) => method === 'sessionEvidence' && args.revision === 'v1' ? first.promise : { ok: true });
  app.update('a', { ...base, evidence: 'x'.repeat(50000) });
  app.update('a', { ...base, evidenceRevision: 'v2' });
  app.update('a', { ...base, evidenceRevision: 'v3' });
  expect(app.invoke).toHaveBeenCalledTimes(1);
  first.resolve({ ok: true }); await flush();
  expect(app.calls('sessionEvidence').map(args => [args.revision, args.index])).toEqual([['v1', 0], ['v3', 0]]);
  expect(app.calls('sessionContext').map(args => args.evidenceRevision)).toEqual(['v3']);
  expect(app.wake).toHaveBeenCalledTimes(1);
});

it('reuses the confirmed final chunk for a newer context of the same evidence version', async () => {
  const first = deferred();
  const app = setup(async method => method === 'sessionEvidence' ? first.promise : { ok: true });
  app.update('a', base); app.update('a', { ...base, running: true });
  first.resolve({ ok: true }); await flush();
  expect(app.calls('sessionEvidence')).toHaveLength(1);
  expect(app.calls('sessionContext').map(args => args.running)).toEqual([true]);
});

it.each([false, true])('ignores an obsolete context RPC completion (reject=%s)', async reject => {
  const first = deferred();
  let contexts = 0;
  const app = setup(async method => method === 'sessionContext' && ++contexts === 1 ? first.promise : { ok: true });
  app.update('a', base); await flush();
  app.update('a', { ...base, running: true });
  if (reject) first.reject(new Error('old RPC failed')); else first.resolve({ ok: true });
  await flush();
  expect(app.calls('sessionContext').map(args => args.running)).toEqual([false, true]);
  expect(app.calls('sessionEvidence')).toHaveLength(1);
  expect(app.wake).toHaveBeenCalledTimes(1); expect(app.report).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it.each([null, 'b'])('session switch to %s cancels queued context and old retry', async sessionId => {
  const app = setup(async () => { throw new Error('offline'); });
  app.update('a', base); await flush(); expect(vi.getTimerCount()).toBe(1);
  app.update(sessionId); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(app.invoke).toHaveBeenCalledTimes(1); expect(app.wake).not.toHaveBeenCalled();
});

it('session switch drops queued work and in-flight upload continuation, even when switching back', async () => {
  const first = deferred();
  const app = setup(async (method, args) => method === 'sessionEvidence' && args.revision === 'v1' ? first.promise : { ok: true });
  app.update('a', { ...base, evidence: 'x'.repeat(50000) });
  app.update('a', { ...base, evidenceRevision: 'queued' });
  app.update(null); app.update('a', { ...base, evidenceRevision: 'new' });
  first.resolve({ ok: true }); await flush();
  expect(app.calls('sessionEvidence').map(args => [args.revision, args.index])).toEqual([['v1', 0], ['new', 0]]);
  expect(app.calls('sessionContext').map(args => args.evidenceRevision)).toEqual(['new']);
  expect(app.wake).toHaveBeenCalledTimes(1);
});

it('switching during a context RPC suppresses its wake and only publishes the new session', async () => {
  const first = deferred();
  const app = setup(async (method, args) => method === 'sessionContext' && args.sessionId === 'a' ? first.promise : { ok: true });
  app.update('a', base); await flush();
  app.update('b', { ...base, sessionId: 'b' }); first.resolve({ ok: true }); await flush();
  expect(app.calls('sessionContext').map(args => args.sessionId)).toEqual(['a', 'b']);
  expect(app.wake).toHaveBeenCalledTimes(1);
});

it('dispose cancels the timer and ignores future updates', async () => {
  const app = setup(async () => { throw new Error('offline'); });
  app.update('a', base); await flush(); expect(vi.getTimerCount()).toBe(1);
  app.dispose(); app.update('a', { ...base, running: true });
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000);
  expect(app.invoke).toHaveBeenCalledTimes(1); expect(app.wake).not.toHaveBeenCalled();
});

it.each(['sessionEvidence', 'sessionContext'])('dispose during %s RPC forbids continuation, report and wake', async method => {
  const first = deferred();
  const app = setup(async name => name === method ? first.promise : { ok: true });
  app.update('a', { ...base, evidence: 'x'.repeat(50000) }); await flush();
  app.dispose(); const count = app.invoke.mock.calls.length;
  first.reject(new Error('late failure')); await flush();
  expect(app.invoke).toHaveBeenCalledTimes(count); expect(app.wake).not.toHaveBeenCalled(); expect(app.report).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('invalidated renderer cannot write or wake after an in-flight RPC', async () => {
  const first = deferred(), app = setup(async () => first.promise);
  app.update('a', { ...base, evidence: 'x'.repeat(50000) }); app.invalidate();
  first.resolve({ ok: true }); await flush();
  expect(app.invoke).toHaveBeenCalledTimes(1); expect(app.wake).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('does not reuse evidence across changed root or revision', async () => {
  const app = setup();
  for (const context of [base, { ...base, root: '/other' }, { ...base, root: '/other', evidenceRevision: 'v2' }]) { app.update('a', context); await flush(); }
  expect(app.calls('sessionEvidence').map(args => [args.root, args.revision])).toEqual([['/project', 'v1'], ['/other', 'v1'], ['/other', 'v2']]);
});
