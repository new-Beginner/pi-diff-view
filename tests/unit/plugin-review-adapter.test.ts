import React from 'react';
import { it, expect } from 'vitest';
import { createPluginReviewAdapter, hostEntryUrl, resolvePluginReviewModules, REVIEW_TAB_ID } from '../../src/renderer/plugin-review-adapter';
import { NATIVE_BUILD } from '../../src/core/native-build-contract';
const location = 'diff-view:00000000-0000-4000-8000-000000000001';
const info = { version: NATIVE_BUILD.version, supported: true, hashes: Object.fromEntries(Object.values(NATIVE_BUILD.assets).map(asset => [asset.name, asset.sha256])) };
function fixture() {
  const listeners = new Set<() => void>();
  const calls: unknown[] = [], state = { activeSessionId: 's' as string | null | undefined, selectingSessionId: null as string | null, workPanelOpen: false, activeWorkPanelTabId: null as string | null, pluginViews: [{ pluginId: 'local.diff-view', viewId: 'review' }], openWorkPanelTabForSession(sessionId: string, tab: any) { calls.push({ sessionId, tab }); state.workPanelOpen = true; state.activeWorkPanelTabId = tab.id; } };
  const modules = { store: { getState: () => state, subscribe(listener: (value: typeof state) => void) { const notify = () => listener(state); listeners.add(notify); return () => { listeners.delete(notify); }; } }, tab: (pluginId: string, viewId: string) => ({ id: `plugin:${pluginId}/${viewId}`, kind: 'plugin', resource: `${pluginId}/${viewId}` }), hostReact: React };
  return { calls, state, modules, listeners, notify: () => listeners.forEach(listener => listener()) };
}
it('opens only the exact plugin tab and forwards an opaque selection location', async () => {
  const f = fixture(), adapter = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules });
  await adapter.open('s', location); expect(f.calls).toEqual([{ sessionId: 's', tab: { id: REVIEW_TAB_ID, kind: 'plugin', resource: 'local.diff-view/review', location: `${location}?sessionId=s` } }]);
  adapter.close(); await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
});
it('opens on changed versions and hashes without requesting build validation', async () => {
  let inspected = false, loaded = false; const f = fixture(); const adapter = createPluginReviewAdapter({ info: async () => { inspected = true; return { version: '0.18.0', supported: false, hashes: {}, reason: 'Only the inspected PI-Desktop 0.17.0 build is supported' }; }, load: async () => { loaded = true; return f.modules; } });
  await adapter.open('s', location); expect(inspected).toBe(false); expect(loaded).toBe(true); expect(f.calls).toHaveLength(1); adapter.close();
});
it('rejects changed React identity and missing contributed views', async () => {
  const f = fixture(); const wrong = createPluginReviewAdapter({ info: async () => info, load: async () => ({ ...f.modules, hostReact: { ...React, useState: (() => {}) as any } }) });
  await expect(wrong.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_CONTRACT' });
  const missing = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules }); f.state.pluginViews = [];
  await expect(missing.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_VIEW' }); expect(f.calls).toEqual([]);
});
it('rejects session switches, selecting sessions and invalid locations without opening', async () => {
  const f = fixture(), adapter = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules });
  await expect(adapter.open('other', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' }); f.state.selectingSessionId = 'other';
  await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  await expect(adapter.open('s', 'D:/file.txt')).rejects.toMatchObject({ code: 'SIDEBAR_TARGET' }); expect(f.calls).toEqual([]);
});
it('a late module load cannot act after unload', async () => {
  const f = fixture(); let release!: () => void;
  const adapter = createPluginReviewAdapter({ info: async () => info, load: async () => { await new Promise<void>(resolve => release = resolve); return f.modules; } });
  const pending = adapter.open('s', location); await new Promise(resolve => setTimeout(resolve, 0)); adapter.close(); release();
  await expect(pending).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' }); expect(f.calls).toEqual([]);
});
it('reports the actual host session immediately, blocks transitions and releases subscriptions', async () => {
  const f = fixture(), adapter = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules });
  const sessions: (string | null)[] = [], dispose = await adapter.subscribeSession(id => sessions.push(id));
  expect(sessions).toEqual(['s']); expect(f.listeners.size).toBe(1);
  f.notify(); expect(sessions).toEqual(['s']);
  f.state.selectingSessionId = 'other'; f.notify(); expect(sessions).toEqual(['s', null]);
  await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  f.state.activeSessionId = 'other'; f.state.selectingSessionId = null; f.notify(); expect(sessions).toEqual(['s', null, 'other']);
  adapter.close(); expect(f.listeners.size).toBe(0); dispose(); f.state.activeSessionId = 's'; f.notify(); expect(sessions).toEqual(['s', null, 'other']);
});
it('subscribes without build validation but still rejects an unavailable subscription', async () => {
  const f = fixture(); let inspected = false;
  const adapter = createPluginReviewAdapter({ info: async () => { inspected = true; throw new Error('Version probe unavailable'); }, load: async () => f.modules });
  const sessions: (string | null)[] = []; await adapter.subscribeSession(id => sessions.push(id)); expect(inspected).toBe(false); expect(sessions).toEqual(['s']); adapter.close();
  const missing = createPluginReviewAdapter({ info: async () => info, load: async () => ({ ...f.modules, store: { getState: () => f.state } }) });
  await expect(missing.subscribeSession(() => {})).rejects.toMatchObject({ code: 'SIDEBAR_CONTRACT' });
  expect(f.calls).toEqual([]);
});
it('accepts the real new-session undefined state and recovers without a reload', async () => {
  const f = fixture(); f.state.activeSessionId = undefined;
  const adapter = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules });
  const sessions: (string | null)[] = [];
  await adapter.subscribeSession(id => sessions.push(id));
  expect(sessions).toEqual([null]);
  await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  f.state.activeSessionId = 's'; f.notify(); expect(sessions).toEqual([null, 's']);
  await adapter.open('s', location); expect(f.calls).toHaveLength(1); adapter.close();
});
it('uses the current host entry regardless of its build filename', () => {
  const page = 'file:///D:/PI/resources/app.asar/out/renderer/index.html';
  expect(hostEntryUrl(page, ['./assets/index-new-build.js'])).toBe(new URL('./assets/index-new-build.js', page).href);
  expect(hostEntryUrl(page, ['./assets/index.js'])).toBe(new URL('./assets/index.js', page).href);
  expect(() => hostEntryUrl(page, ['./assets/index-a.js', './assets/index-b.js'])).toThrow(/ambiguous/);
  expect(() => hostEntryUrl(page, ['https://example.com/assets/index-a.js'])).toThrow(/missing/);
  expect(() => hostEntryUrl('https://example.com/index.html', ['./assets/index-a.js'])).toThrow(/local host/);
});
it('opens the review tab when the old minified factory export has changed', async () => {
  const f = fixture(); let oldFactoryCalled = false;
  const modules = resolvePluginReviewModules({ R: f.modules.store, r: React, aO: () => { oldFactoryCalled = true; return { id: 'other', kind: 'file', resource: 'other' }; } });
  const adapter = createPluginReviewAdapter({ load: async () => modules });
  const sessions: (string | null)[] = []; await adapter.subscribeSession(id => sessions.push(id));
  await adapter.open('s', location);
  expect(oldFactoryCalled).toBe(false); expect(sessions).toEqual(['s']);
  expect(f.calls).toEqual([{ sessionId: 's', tab: { id: REVIEW_TAB_ID, kind: 'plugin', resource: 'local.diff-view/review', location: `${location}?sessionId=s` } }]); adapter.close();
});
it('does not require a host tab factory export and still validates store and React', async () => {
  const f = fixture();
  const adapter = createPluginReviewAdapter({ load: async () => resolvePluginReviewModules({ R: f.modules.store, r: React }) });
  await adapter.open('s', location); expect(f.calls).toHaveLength(1); adapter.close();
  const invalid = createPluginReviewAdapter({ load: async () => resolvePluginReviewModules({ R: {}, r: React }) });
  await expect(invalid.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_CONTRACT' });
});
it('does not reopen an already active panel at the same location, but restores a collapsed one', async () => {
  const f = fixture(); const tab = f.modules.tab('local.diff-view', 'review');
  Object.assign(f.state, { workPanelTabs: [{ ...tab, location: `${location}?sessionId=s` }], workPanelOpen: true, activeWorkPanelTabId: REVIEW_TAB_ID });
  const adapter = createPluginReviewAdapter({ load: async () => f.modules });
  await adapter.open('s', location); expect(f.calls).toHaveLength(0);
  f.state.workPanelOpen = false; await adapter.open('s', location); expect(f.calls).toEqual([{ sessionId: 's', tab: { ...tab, location: `${location}?sessionId=s` } }]);
  f.state.selectingSessionId = 'other'; await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' }); adapter.close();
});
it('opens the exact File Manager tab with an unmodified file path', async () => {
  const f = fixture(); f.state.pluginViews.push({ pluginId: 'pi.file-manager', viewId: 'manager' });
  const adapter = createPluginReviewAdapter({ load: async () => f.modules });
  const path = 'D:/中文 project/src/a #?.ts';
  await adapter.openFile('s', path);
  expect(f.calls).toEqual([{ sessionId: 's', tab: { id: 'plugin:pi.file-manager/manager', kind: 'plugin', resource: 'pi.file-manager/manager', location: path } }]);
  adapter.close(); await expect(adapter.openFile('s', path)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
});
it('never falls back to expanding a diff when File Manager is missing or the session changes', async () => {
  const f = fixture(), adapter = createPluginReviewAdapter({ load: async () => f.modules });
  await expect(adapter.openFile('s', 'D:/a.ts')).rejects.toMatchObject({ code: 'SIDEBAR_VIEW' });
  f.state.pluginViews.push({ pluginId: 'pi.file-manager', viewId: 'manager' });
  f.state.selectingSessionId = 'other';
  await expect(adapter.openFile('s', 'D:/a.ts')).rejects.toMatchObject({ code: 'SIDEBAR_SESSION' });
  expect(f.calls).toEqual([]); adapter.close();
});
it('reuses a warm File Manager tab and skips opening an already active identical file', async () => {
  const f = fixture(); f.state.pluginViews.push({ pluginId: 'pi.file-manager', viewId: 'manager' });
  const tab = { ...f.modules.tab('pi.file-manager', 'manager'), location: 'D:/project/a.ts', label: 'Files' };
  Object.assign(f.state, { workPanelTabs: [tab], workPanelOpen: true, activeWorkPanelTabId: tab.id });
  const adapter = createPluginReviewAdapter({ load: async () => f.modules });
  await adapter.openFile('s', tab.location); expect(f.calls).toEqual([]);
  await adapter.openFile('s', 'D:/project/b.ts');
  expect(f.calls).toEqual([{ sessionId: 's', tab: { ...tab, location: 'D:/project/b.ts' } }]);
  adapter.close();
});
it('rejects a stale file navigation generation after an asynchronous host load', async () => {
  const f = fixture(); f.state.pluginViews.push({ pluginId: 'pi.file-manager', viewId: 'manager' });
  let release!: () => void, current = true;
  const adapter = createPluginReviewAdapter({ load: async () => { await new Promise<void>(resolve => { release = resolve; }); return f.modules; } });
  const pending = adapter.openFile('s', 'D:/project/a.ts', () => { if (!current) throw new Error('Stale navigation generation'); });
  current = false; release();
  await expect(pending).rejects.toThrow('Stale navigation generation'); expect(f.calls).toEqual([]); adapter.close();
});

it('never borrows global running state when this session has no scoped status', async () => {
  const f = fixture(); Object.assign(f.state, { page: 'chat', isRunning: true, runningSessions: { other: true }, messages: [{ id: 'user-s', role: 'user', createdAt: Date.now() - 100 }] });
  const adapter = createPluginReviewAdapter({ load: async () => f.modules });
  const contexts: any[] = [], activities: any[] = [];
  await adapter.subscribeSession((_id, context) => contexts.push(context));
  await adapter.subscribeActivity(activity => activities.push(activity));
  expect(contexts[0].running).toBe(false); expect(contexts[0].statusKnown).toBe(false); expect(activities).toEqual([null]);
  adapter.close();
});

it('reports the unified running context with an idle main and uses Task launch time for missing tool timestamps', async () => {
  const f = fixture(), since = Date.now() - 2000;
  Object.assign(f.state, { page: 'chat', runningSessions: { s: false }, messages: [{ id: 'original', role: 'user', createdAt: since }, { id: 'launch-row', role: 'tool', toolCallId: 'launch', toolName: 'Task', toolStatus: 'success', toolResult: { details: { delegationId: 'd', status: 'running', startedAt: since + 100 } } }, { id: 'newer', role: 'user', createdAt: since + 500 }] });
  const adapter = createPluginReviewAdapter({ load: async () => f.modules });
  let context: unknown; await adapter.subscribeSession((_id, value) => { context = value; });
  expect(context).toMatchObject({ sessionId: 's', running: true, mainRunning: false, taskId: 'original', since });
  adapter.close();
});
