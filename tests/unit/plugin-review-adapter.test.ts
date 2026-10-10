import React from 'react';
import { it, expect } from 'vitest';
import { createPluginReviewAdapter, REVIEW_TAB_ID } from '../../src/renderer/plugin-review-adapter';
import { NATIVE_BUILD } from '../../src/core/native-build-contract';
const location = 'diff-view:00000000-0000-4000-8000-000000000001';
const info = { version: NATIVE_BUILD.version, supported: true, hashes: Object.fromEntries(Object.values(NATIVE_BUILD.assets).map(asset => [asset.name, asset.sha256])) };
function fixture() {
  const calls: unknown[] = [], state = { activeSessionId: 's', selectingSessionId: null as string | null, workPanelOpen: false, activeWorkPanelTabId: null as string | null, pluginViews: [{ pluginId: 'local.diff-view', viewId: 'review' }], openWorkPanelTabForSession(sessionId: string, tab: any) { calls.push({ sessionId, tab }); state.workPanelOpen = true; state.activeWorkPanelTabId = tab.id; } };
  const modules = { store: { getState: () => state }, tab: (pluginId: string, viewId: string) => ({ id: `plugin:${pluginId}/${viewId}`, kind: 'plugin', resource: `${pluginId}/${viewId}` }), hostReact: React };
  return { calls, state, modules };
}
it('opens only the exact plugin tab and forwards an opaque selection location', async () => {
  const f = fixture(), adapter = createPluginReviewAdapter({ info: async () => info, load: async () => f.modules });
  await adapter.open('s', location); expect(f.calls).toEqual([{ sessionId: 's', tab: { id: REVIEW_TAB_ID, kind: 'plugin', resource: 'local.diff-view/review', location } }]);
  adapter.close(); await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_UNLOADED' });
});
it('fails closed on a changed build before loading internal modules', async () => {
  let loaded = false; const f = fixture(); const adapter = createPluginReviewAdapter({ info: async () => ({ ...info, version: '0.18.0' }), load: async () => { loaded = true; return f.modules; } });
  await expect(adapter.open('s', location)).rejects.toMatchObject({ code: 'SIDEBAR_BUILD' }); expect(loaded).toBe(false); expect(f.calls).toEqual([]);
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
