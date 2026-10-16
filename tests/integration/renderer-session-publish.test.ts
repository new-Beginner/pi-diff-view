import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onLoad, onUnload } from '../../src/renderer';
import type { RendererHost } from '../../src/renderer/host-contract';
import type { PluginReviewAdapter, SessionContext } from '../../src/renderer/plugin-review-adapter';

// Exercise renderer lifecycle without bridge admission timers.
vi.mock('../../src/view/transport', () => ({ ensureBounded: (transport: unknown) => transport }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { onUnload(); vi.clearAllTimers(); vi.useRealTimers(); });
const context: SessionContext = { sessionId: 'a', root: '/project', running: false, evidence: '[]', evidenceRevision: 'v1' };
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function setup(handle: (method: string, args: any) => Promise<unknown>, failSubscription = false) {
  let listener!: (sessionId: string | null, context?: SessionContext) => void;
  const unsubscribe = vi.fn();
  const subscribeSession = vi.fn(async (next: typeof listener) => {
    if (failSubscription) { failSubscription = false; throw new Error('subscribe failed'); }
    listener = next; return unsubscribe;
  });
  const adapter: PluginReviewAdapter = { subscribeSession, subscribeActivity: async () => () => {}, open: async () => {}, close: vi.fn() };
  const dispatch = vi.fn(async (_action: string, { method, args }: { method: string; args?: unknown }) => {
    if (method === 'replyCards') return { cards: [], revision: 'r', pending: [], nextOffset: null, locale: 'zh-CN', base: 'light' };
    return handle(method, args);
  });
  const host = { dispatch, ui: { injectStyle: () => () => {} }, slots: { register: () => () => {} }, composer: { subscribeDraft: () => () => {} } } as RendererHost;
  onLoad(host, { adapter });
  return { emit: (id: string | null, value?: SessionContext) => listener(id, value), dispatch, subscribeSession, unsubscribe };
}

it.each(['sessionEvidence', 'sessionContext'])('retries the latest context after %s fails without another host event', async failedMethod => {
  let failed = false;
  const writes: { method: string; args: any }[] = [];
  const app = setup(async (method, args) => {
    if (method === 'sessionEvidence' || method === 'sessionContext') writes.push({ method, args });
    if (method === failedMethod && !failed) { failed = true; throw new Error('transient'); }
    return { ok: true };
  });
  app.emit('a', context); await flush();
  await vi.advanceTimersByTimeAsync(500); await flush();
  expect(writes.filter(write => write.method === failedMethod)).toHaveLength(2);
  expect(writes.at(-1)).toEqual({ method: 'sessionContext', args: { sessionId: 'a', root: '/project', running: false, evidenceRevision: 'v1' } });
  expect(writes.filter(write => write.method === 'sessionEvidence')).toHaveLength(failedMethod === 'sessionEvidence' ? 2 : 1);
});

it('keeps the initial subscribeSession failure retry', async () => {
  const app = setup(async () => ({ ok: true }), true); await flush();
  expect(app.subscribeSession).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999); expect(app.subscribeSession).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(app.subscribeSession).toHaveBeenCalledTimes(2);
  app.emit('a', context); await flush();
  expect(app.dispatch.mock.calls.some(([, payload]) => payload.method === 'sessionContext')).toBe(true);
  onUnload(); expect(app.unsubscribe).toHaveBeenCalledTimes(1);
});

it('cancels publication retry on renderer unload and ignores late subscription events', async () => {
  const app = setup(async method => { if (method === 'sessionEvidence') throw new Error('offline'); return { ok: true }; });
  app.emit('a', context); await flush();
  onUnload(); const count = app.dispatch.mock.calls.length;
  app.emit('a', { ...context, evidenceRevision: 'v2' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(app.dispatch).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('passes a null session switch through to cancel the in-flight upload continuation', async () => {
  let resolve!: (value: unknown) => void;
  const first = new Promise(yes => { resolve = yes; });
  const app = setup(async method => method === 'sessionEvidence' ? first : { ok: true });
  app.emit('a', { ...context, evidence: 'x'.repeat(50000) }); await flush();
  app.emit(null); resolve({ ok: true }); await flush();
  await vi.advanceTimersByTimeAsync(3000);
  const methods = app.dispatch.mock.calls.map(([, payload]) => payload.method);
  expect(methods.filter(method => method === 'sessionEvidence')).toHaveLength(1);
  expect(methods).not.toContain('sessionContext');
});

it('a new session replaces the old session retry', async () => {
  const app = setup(async (method, args) => {
    if (method === 'sessionEvidence' && args.sessionId === 'a') throw new Error('old session offline');
    return { ok: true };
  });
  app.emit('a', context); await flush();
  app.emit('b', { ...context, sessionId: 'b' }); await flush();
  await vi.advanceTimersByTimeAsync(3000);
  const payloads = app.dispatch.mock.calls.map(([, payload]) => payload);
  expect(payloads.filter(payload => payload.method === 'sessionEvidence').map(payload => (payload.args as SessionContext).sessionId)).toEqual(['a', 'b']);
  expect(payloads.filter(payload => payload.method === 'sessionContext').map(payload => (payload.args as SessionContext).sessionId)).toEqual(['b']);
});

it('unload during a context RPC suppresses late completion and wake timers', async () => {
  let resolve!: (value: unknown) => void;
  const first = new Promise(yes => { resolve = yes; });
  const app = setup(async method => method === 'sessionContext' ? first : { ok: true });
  app.emit('a', context); await flush();
  onUnload(); const count = app.dispatch.mock.calls.length;
  resolve({ ok: true }); await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect(app.dispatch).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
});

it('default renderer follows DOM even when the private evidence module is unavailable', async () => {
  let id: string | null = 'a', notify = () => {};
  const document = { querySelectorAll(selector: string) {
    return selector.startsWith('[data-session-pane]') && id ? [{ getAttribute: () => id }] : [];
  }, documentElement: {}, location: { href: 'https://unsupported-host.invalid' } };
  class Observer { constructor(callback: (records: unknown[]) => void) { notify = () => callback([]); } observe() {} disconnect() {} }
  vi.stubGlobal('document', document); vi.stubGlobal('MutationObserver', Observer);
  const calls: any[] = [];
  const host = { dispatch: async (_action: string, payload: any) => {
    calls.push(payload);
    if (payload.method === 'replyCards') return { cards: [], revision: 'r', pending: [], nextOffset: null, locale: 'zh-CN', base: 'light' };
    return { ok: true };
  }, ui: { injectStyle: () => () => {} }, slots: { register: () => () => {} } } as unknown as RendererHost;
  try {
    onLoad(host); await flush();
    expect(calls.some(row => row.method === 'reviewSurface' && row.args.sessionId === 'a')).toBe(true);
    id = 'b'; notify(); await flush();
    expect(calls.some(row => row.method === 'reviewSurface' && row.args.sessionId === 'b')).toBe(true);
    expect(calls.filter(row => row.method === 'sessionContext')).toHaveLength(0);
    onUnload(); const before = calls.length; notify(); await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toHaveLength(before);
  } finally { onUnload(); vi.unstubAllGlobals(); }
});
