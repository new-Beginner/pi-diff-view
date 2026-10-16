import { afterEach, it, expect, vi } from 'vitest';
import { createPluginReviewAdapter, domSession, REVIEW_TAB_ID, type SessionContext } from '../../src/renderer/plugin-review-adapter';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const location = 'diff-view:00000000-0000-4000-8000-000000000001';
function fixture() {
  const attributes = (values: Record<string, string>) => ({ getAttribute: (key: string) => values[key] ?? null });
  const nodes = new Map<string, any[]>([['[data-session-pane][data-visible="true"]', [attributes({ 'data-session-pane': 's' })]]]);
  const document = { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] } as unknown as Document;
  let notify = () => {}; const disconnect = vi.fn();
  const observe = (callback: () => void) => { notify = callback; return { disconnect }; };
  const read = vi.fn(async (sessionId: string): Promise<SessionContext> => ({ sessionId, running: false, statusKnown: true }));
  const navigation = { prepare: vi.fn(async () => 'ticket'), confirm: vi.fn(async () => {}) };
  const toggle = { ...attributes({ 'aria-pressed': 'true' }), closest: () => null, click: vi.fn() };
  const tab = { ...attributes({ 'aria-selected': 'true' }), closest: () => null, click: vi.fn() };
  nodes.set('.app-work-panel-toggle', [toggle]); nodes.set(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`, [tab]);
  const adapter = createPluginReviewAdapter({ document, observe, read, navigation });
  return { adapter, document, nodes, attributes, notify: () => notify(), disconnect, read, navigation, toggle, tab };
}
it('follows DOM immediately without requesting state; releases observers', async () => {
  const f = fixture(), sessions: unknown[] = []; const stop = await f.adapter.subscribeSession(id => sessions.push(id));
  f.notify(); expect(sessions).toEqual(['s']);
  f.nodes.set('[data-session-pane][data-visible="true"]', []); f.notify();
  f.nodes.set('.thread-item.active[data-sidebar-session-row]', [f.attributes({ 'data-sidebar-session-row': 'other' })]); f.notify();
  expect(sessions).toEqual(['s', null, 'other']); expect(f.read).not.toHaveBeenCalled();
  f.adapter.close(); stop(); f.notify(); expect(f.disconnect).toHaveBeenCalledTimes(1); expect(sessions).toHaveLength(3);
});
it('refuses duplicate panes, duplicate rows, invalid ids and switching conflicts', () => {
  const f = fixture(); f.nodes.set('.thread-item.active[data-sidebar-session-row]', [f.attributes({ 'data-sidebar-session-row': 'other' })]);
  expect(domSession(f.document)).toBeNull(); f.nodes.delete('.thread-item.active[data-sidebar-session-row]');
  f.nodes.get('[data-session-pane][data-visible="true"]')!.push(f.attributes({ 'data-session-pane': 's' })); expect(domSession(f.document)).toBeNull();
  f.nodes.set('[data-session-pane][data-visible="true"]', [f.attributes({ 'data-session-pane': '../../secrets' })]); expect(domSession(f.document)).toBeNull();
});
it('opens an already active exact tab without reading state or clicking again, and confirms navigation', async () => {
  const f = fixture(); await f.adapter.open('s', location);
  expect(f.read).not.toHaveBeenCalled(); expect(f.tab.click).not.toHaveBeenCalled();
  expect(f.navigation.prepare).toHaveBeenCalledWith('s', location, expect.any(Function)); expect(f.navigation.confirm).toHaveBeenCalledWith('ticket', expect.any(Function));
  f.adapter.close(); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
  expect(f.adapter).not.toHaveProperty('openFile');
});
it('rejects wrong sessions, invalid tokens, duplicate controls and late navigation after unload', async () => {
  const f = fixture(); await expect(f.adapter.open('other', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  await expect(f.adapter.open('s', '/file')).rejects.toMatchObject({ code: 'SIDEBAR_TARGET' });
  f.nodes.set('.app-work-panel-toggle', [f.toggle, f.toggle]); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_AMBIGUOUS' });
  f.nodes.set('.app-work-panel-toggle', [f.toggle]);
  let release!: (value: string) => void; f.navigation.prepare.mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const pending = f.adapter.open('s', location); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_BUSY' });
  f.adapter.close(); release('ticket'); await expect(pending).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' }); expect(f.navigation.confirm).not.toHaveBeenCalled();
});
it('reads public state using DOM ownership and shares it between evidence and activity', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.read.mockResolvedValue({ sessionId: 's', running: true, mainRunning: false, statusKnown: true, taskId: 'original', since: 100, evidenceRevision: 'r1' });
  const evidence = vi.fn(), activity = vi.fn();
  try {
    await f.adapter.subscribeEvidence!(evidence); await f.adapter.subscribeActivity(activity); await flush();
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledWith('s');
    expect(evidence).toHaveBeenLastCalledWith('s', expect.objectContaining({ taskId: 'original', mainRunning: false, evidenceRevision: 'r1' }));
    expect(activity).toHaveBeenLastCalledWith({ sessionId: 's', taskId: 'original', since: 100 });
    f.nodes.set('[data-session-pane][data-visible="true"]', []); f.notify();
    expect(evidence).toHaveBeenLastCalledWith(null, undefined); expect(activity).toHaveBeenLastCalledWith(null);
  } finally { f.adapter.close(); }
});
it('fails closed without a public reader, with no private-module fallback', async () => {
  vi.useFakeTimers(); const f = fixture();
  const adapter = createPluginReviewAdapter({ document: f.document, observe: () => ({ disconnect() {} }) });
  const evidence = vi.fn(), activity = vi.fn(), diagnostic = vi.fn();
  try {
    await adapter.subscribeEvidence!(evidence); await adapter.subscribeActivity(activity, diagnostic); await flush();
    expect(evidence).toHaveBeenLastCalledWith('s', { sessionId: 's', running: false, statusKnown: false });
    expect(activity).toHaveBeenLastCalledWith(null); expect(diagnostic).toHaveBeenLastCalledWith('running-identity-missing');
  } finally { adapter.close(); f.adapter.close(); }
});

it('expands the panel, opens the launcher and selects only its contributed view once', async () => {
  vi.useFakeTimers(); const f = fixture();
  const button = (values: Record<string, string>, click: () => void) => ({ getAttribute: (key: string) => values[key] ?? null, closest: () => null, click: vi.fn(click) });
  const pressed = { 'aria-pressed': 'false' };
  const toggle = button(pressed, () => { pressed['aria-pressed'] = 'true'; });
  const launcher = button({}, () => f.nodes.set(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`, [f.tab]));
  const plus = button({}, () => f.nodes.set('[data-work-panel-launcher-item="local.diff-view/review"]', [launcher]));
  f.nodes.set('.app-work-panel-toggle', [toggle]); f.nodes.set('.work-panel-new-tab', [plus]); f.nodes.delete(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`);
  try {
    const opening = f.adapter.open('s', location); await vi.advanceTimersByTimeAsync(250); await opening;
    expect(toggle.click).toHaveBeenCalledTimes(1); expect(plus.click).toHaveBeenCalledTimes(1); expect(launcher.click).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
  } finally { f.adapter.close(); vi.useRealTimers(); }
});
it('does not endlessly click or replay when a host control does not react', async () => {
  vi.useFakeTimers(); const f = fixture(); f.nodes.delete(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`);
  const click = vi.fn(); f.nodes.set('.work-panel-new-tab', [{ getAttribute: () => null, closest: () => null, click }]);
  try {
    const pending = expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_OPEN' });
    await vi.advanceTimersByTimeAsync(4100); await pending; expect(click).toHaveBeenCalledTimes(1); expect(f.navigation.confirm).not.toHaveBeenCalled();
  } finally { f.adapter.close(); vi.useRealTimers(); }
});
it('does not synthesize an empty identity for unrelated same-session DOM mutations', async () => {
  const f = fixture(), sessions: unknown[] = []; let callback!: MutationCallback;
  vi.stubGlobal('MutationObserver', class { constructor(value: MutationCallback) { callback = value; } observe() {} disconnect() {} });
  const adapter = createPluginReviewAdapter({ document: f.document });
  try {
    await adapter.subscribeSession(id => sessions.push(id));
    callback([{ type: 'attributes', attributeName: 'data-visible', oldValue: 'true', target: { getAttribute: () => 's' } } as unknown as MutationRecord], {} as MutationObserver);
    expect(sessions).toEqual(['s']);
  } finally { adapter.close(); vi.unstubAllGlobals(); }
});
it('reveals the panel before slow selection validation finishes', async () => {
  vi.useFakeTimers(); const f = fixture(); let release!: (value: string) => void;
  f.navigation.prepare.mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const values = { 'aria-pressed': 'false' };
  f.nodes.set('.app-work-panel-toggle', [{ getAttribute: (key: keyof typeof values) => values[key], closest: () => null, click: () => { values['aria-pressed'] = 'true'; } }]);
  try {
    const opening = f.adapter.open('s', location);
    await vi.advanceTimersByTimeAsync(90);
    expect(values['aria-pressed']).toBe('true');
    release('ticket'); await vi.advanceTimersByTimeAsync(100); await opening;
  } finally { f.adapter.close(); vi.useRealTimers(); }
});
it('invalidates batched A → B → A identities/visibility, but ignores changes to hidden panes', async () => {
  const f = fixture(), sessions: unknown[] = []; let callback!: MutationCallback;
  vi.stubGlobal('MutationObserver', class { constructor(value: MutationCallback) { callback = value; } observe() {} disconnect() {} });
  const adapter = createPluginReviewAdapter({ document: f.document });
  const mutation = (attributeName: string, oldValue: string, values: Record<string, string>) => ({ type: 'attributes', attributeName, oldValue, target: f.attributes(values) } as unknown as MutationRecord);
  try {
    await adapter.subscribeSession(id => sessions.push(id));
    callback([mutation('data-session-pane', 'hidden-old', { 'data-session-pane': 'hidden-new' })], {} as MutationObserver);
    expect(sessions).toEqual(['s']);
    callback([mutation('data-session-pane', 'other', { 'data-session-pane': 's' })], {} as MutationObserver);
    expect(sessions).toEqual(['s', null, 's']);
    callback([mutation('data-visible', 'false', { 'data-session-pane': 's', 'data-visible': 'true' })], {} as MutationObserver);
    expect(sessions).toEqual(['s', null, 's', null, 's']);
  } finally { adapter.close(); vi.unstubAllGlobals(); }
});
it.each(['data-session-pane', 'data-visible', 'class'])('invalidates a batched %s excursion on the public polling source too', async attributeName => {
  vi.useFakeTimers(); const f = fixture(), callbacks: MutationCallback[] = [];
  vi.stubGlobal('MutationObserver', class { constructor(callback: MutationCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
  let release!: (context: SessionContext) => void;
  const read = vi.fn(async (sessionId: string): Promise<SessionContext> => ({ sessionId, running: true, statusKnown: true, taskId: 'fresh', since: 100 }));
  read.mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const adapter = createPluginReviewAdapter({ document: f.document, read }), sessions = vi.fn(), evidence = vi.fn(), activity = vi.fn();
  const mutate = (oldValue: string) => {
    const target = { ...f.attributes({ 'data-session-pane': 's', 'data-visible': 'true', 'data-sidebar-session-row': 's' }), classList: { contains: () => true } };
    const records = [{ type: 'attributes', attributeName, oldValue, target } as unknown as MutationRecord];
    for (const callback of callbacks) callback(records, {} as MutationObserver);
  };
  try {
    await adapter.subscribeSession(sessions); await adapter.subscribeEvidence!(evidence); await adapter.subscribeActivity(activity); await flush();
    // Unrelated same-session mutation must not invalidate or trigger another read.
    mutate(attributeName === 'data-session-pane' ? 's' : attributeName === 'class' ? 'active' : 'true');
    expect(sessions.mock.calls.map(([id]) => id)).toEqual(['s']); expect(evidence).toHaveBeenCalledTimes(1);
    mutate(attributeName === 'data-session-pane' ? 'other' : attributeName === 'class' ? 'inactive' : 'false');
    expect(sessions.mock.calls.map(([id]) => id)).toEqual(['s', null, 's']);
    expect(evidence.mock.calls.map(([id]) => id)).toEqual(['s', null, 's']);
    expect(activity).toHaveBeenLastCalledWith(null); expect(read).toHaveBeenCalledTimes(1);
    release({ sessionId: 's', running: true, statusKnown: true, taskId: 'stale', since: 100 }); await flush();
    expect(read).toHaveBeenCalledTimes(2); expect(evidence).toHaveBeenLastCalledWith('s', expect.objectContaining({ taskId: 'fresh' }));
    expect(evidence.mock.calls.some(([, context]) => context?.taskId === 'stale')).toBe(false);
  } finally { adapter.close(); f.adapter.close(); }
});
