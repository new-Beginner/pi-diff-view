import React from 'react';
import { it, expect, vi } from 'vitest';
import { createPluginReviewAdapter, domSession, hostEntryUrl, resolvePluginReviewModules, REVIEW_TAB_ID } from '../../src/renderer/plugin-review-adapter';
import { createHostStateAdapter } from '../../src/renderer/host-state-adapter';
const location = 'diff-view:00000000-0000-4000-8000-000000000001';
function fixture() {
  const attributes = (values: Record<string, string>) => ({ getAttribute: (key: string) => values[key] ?? null });
  const nodes = new Map<string, any[]>([['[data-session-pane][data-visible="true"]', [attributes({ 'data-session-pane': 's' })]]]);
  const document = { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] } as unknown as Document;
  let notify = () => {}; const disconnect = vi.fn();
  const observe = (callback: () => void) => { notify = callback; return { disconnect }; };
  const load = vi.fn(async (): Promise<any> => { throw new Error('Host store unavailable'); });
  const navigation = { prepare: vi.fn(async () => 'ticket'), confirm: vi.fn(async () => {}) };
  const toggle = { ...attributes({ 'aria-pressed': 'true' }), closest: () => null, click: vi.fn() };
  const tab = { ...attributes({ 'aria-selected': 'true' }), closest: () => null, click: vi.fn() };
  nodes.set('.app-work-panel-toggle', [toggle]); nodes.set(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`, [tab]);
  const adapter = createPluginReviewAdapter({ document, observe, load, navigation });
  return { adapter, document, nodes, attributes, notify: () => notify(), disconnect, load, navigation, toggle, tab };
}
it('follows DOM immediately without ever loading the host store; releases observers', async () => {
  const f = fixture(), sessions: unknown[] = []; const stop = await f.adapter.subscribeSession(id => sessions.push(id));
  f.notify(); expect(sessions).toEqual(['s']);
  f.nodes.set('[data-session-pane][data-visible="true"]', []); f.notify();
  f.nodes.set('.thread-item.active[data-sidebar-session-row]', [f.attributes({ 'data-sidebar-session-row': 'other' })]); f.notify();
  expect(sessions).toEqual(['s', null, 'other']); expect(f.load).not.toHaveBeenCalled();
  f.adapter.close(); stop(); f.notify(); expect(f.disconnect).toHaveBeenCalledTimes(1); expect(sessions).toHaveLength(3);
});
it('refuses duplicate panes, duplicate rows, invalid ids and switching conflicts', () => {
  const f = fixture(); f.nodes.set('.thread-item.active[data-sidebar-session-row]', [f.attributes({ 'data-sidebar-session-row': 'other' })]);
  expect(domSession(f.document)).toBeNull(); f.nodes.delete('.thread-item.active[data-sidebar-session-row]');
  f.nodes.get('[data-session-pane][data-visible="true"]')!.push(f.attributes({ 'data-session-pane': 's' })); expect(domSession(f.document)).toBeNull();
  f.nodes.set('[data-session-pane][data-visible="true"]', [f.attributes({ 'data-session-pane': '../../secrets' })]); expect(domSession(f.document)).toBeNull();
});
it('opens an already active exact tab without touching store or clicking again, and confirms navigation', async () => {
  const f = fixture(); await f.adapter.open('s', location);
  expect(f.load).not.toHaveBeenCalled(); expect(f.tab.click).not.toHaveBeenCalled();
  expect(f.navigation.prepare).toHaveBeenCalledWith('s', location, expect.any(Function)); expect(f.navigation.confirm).toHaveBeenCalledWith('ticket', expect.any(Function));
  f.adapter.close(); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
  expect(f.adapter).not.toHaveProperty('openFile');
});
it('rejects wrong sessions, invalid tokens, duplicate controls and late navigation after unload', async () => {
  const f = fixture(); await expect(f.adapter.open('other', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  await expect(f.adapter.open('s', '/file')).rejects.toMatchObject({ code: 'SIDEBAR_TARGET' });
  f.nodes.set('.app-work-panel-toggle', [f.toggle, f.toggle]); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_AMBIGUOUS' });
  let release!: (value: string) => void; f.navigation.prepare.mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const pending = f.adapter.open('s', location); await expect(f.adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_BUSY' });
  f.adapter.close(); release('ticket'); await expect(pending).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' }); expect(f.navigation.confirm).not.toHaveBeenCalled();
});
it('retains private evidence/activity reads separately and validates React/store identity', async () => {
  const state = { activeSessionId: 's', page: 'chat', isRunning: true, runningSessions: { other: true }, messages: [{ id: 'u', role: 'user', createdAt: Date.now() - 100 }] };
  const load = async () => resolvePluginReviewModules({ R: { getState: () => state, subscribe: () => () => {} }, r: React });
  const legacy = createHostStateAdapter({ load }); const contexts: any[] = [], activities: any[] = [];
  await legacy.subscribeEvidence((_id, context) => contexts.push(context)); await legacy.subscribeActivity(value => activities.push(value));
  expect(contexts[0]).toMatchObject({ sessionId: 's', running: false, statusKnown: false }); expect(activities).toEqual([null]); legacy.close();
  const broken = createHostStateAdapter({ load: async () => resolvePluginReviewModules({ R: {}, r: React }) });
  await expect(broken.subscribeEvidence(() => {})).rejects.toMatchObject({ code: 'SIDEBAR_CONTRACT' });
});
it('keeps the remaining evidence import constrained to the local unique host entry', () => {
  const page = 'file:///D:/PI/resources/app.asar/out/renderer/index.html';
  expect(hostEntryUrl(page, ['./assets/index-new.js'])).toBe(new URL('./assets/index-new.js', page).href);
  expect(() => hostEntryUrl(page, ['./assets/index-a.js', './assets/index-b.js'])).toThrow(/ambiguous/);
  expect(() => hostEntryUrl('https://example.com', ['./assets/index.js'])).toThrow(/local host/);
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
    expect(toggle.click).toHaveBeenCalledTimes(1); expect(plus.click).toHaveBeenCalledTimes(1); expect(launcher.click).toHaveBeenCalledTimes(1); expect(f.load).not.toHaveBeenCalled();
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
it('keeps delegated task ownership and late-load cancellation on the separate evidence path', async () => {
  const since = Date.now() - 2000;
  const state = { activeSessionId: 's', page: 'chat', runningSessions: { s: false }, messages: [{ id: 'original', role: 'user', createdAt: since }, { id: 'launch-row', role: 'tool', toolCallId: 'launch', toolName: 'Task', toolStatus: 'success', toolResult: { details: { delegationId: 'd', status: 'running', startedAt: since + 100 } } }, { id: 'newer', role: 'user', createdAt: since + 500 }] };
  const modules = { store: { getState: () => state, subscribe: () => () => {} }, hostReact: React };
  const adapter = createHostStateAdapter({ load: async () => modules }); let context: unknown;
  await adapter.subscribeEvidence((_id, value) => { context = value; }); expect(context).toMatchObject({ sessionId: 's', running: true, mainRunning: false, taskId: 'original', since }); adapter.close();
  let release!: (value: typeof modules) => void;
  const late = createHostStateAdapter({ load: () => new Promise(resolve => release = resolve) });
  const pending = late.subscribeEvidence(() => {}); late.close(); release(modules);
  await expect(pending).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
});
