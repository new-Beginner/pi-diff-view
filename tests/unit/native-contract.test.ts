import { it, expect, vi } from 'vitest';
import React from 'react';
import { NATIVE_BUILD, matchesNativeBuild, type NativeBuildInfo } from '../../src/core/native-build-contract';
import { createNativeReviewAdapter, pinnedModuleUrls, nativeDisplayDto, type NativeModules } from '../../src/renderer/native-review-adapter';
const hashes = Object.fromEntries(Object.values(NATIVE_BUILD.assets).map(a => [a.name, a.sha256]));
const info: NativeBuildInfo = { version: '0.17.0', hashes, supported: true };
function native(): NativeModules { return { hostReact: React, component: 'div', tab: kind => ({ id: kind, kind }), parse: () => null, records: () => [], store: { subscribe: () => () => {}, getState: () => ({ activeSessionId: 's', messages: [], workPanelOpen: false, activeWorkPanelTabId: null, openWorkPanelTabForSession: () => {} }) } }; }
it('pins both version and all three content hashes', () => { expect(matchesNativeBuild('0.17.0', hashes)).toBe(true); expect(matchesNativeBuild('0.17.1', hashes)).toBe(false); expect(matchesNativeBuild('0.17.0', { ...hashes, [NATIVE_BUILD.assets.panel.name]: 'changed' })).toBe(false); });
it('reuses only the already-present native document entry URL', () => {
  const page = 'file:///D:/App/resources/app.asar/out/renderer/index.html';
  expect(pinnedModuleUrls(page, ['./assets/index-DKEhNN1e.js']).main).toBe('file:///D:/App/resources/app.asar/out/renderer/assets/index-DKEhNN1e.js');
  for (const url of ['https://example.test/index.html', 'file:///D:/workspace/index.html']) expect(() => pinnedModuleUrls(url, ['./assets/index-DKEhNN1e.js'])).toThrow('renderer');
  expect(() => pinnedModuleUrls(page, [])).toThrow('document entry');
  expect(() => pinnedModuleUrls(page, ['./assets/index-DKEhNN1e.js', './assets/index-DKEhNN1e.js'])).toThrow('document entry');
});
it('never loads modules for unknown versions or mismatched signatures', async () => {
  const load = vi.fn(); const adapter = createNativeReviewAdapter({ info: async () => ({ ...info, version: '0.18.0' }), load });
  await expect(adapter.inspect()).rejects.toMatchObject({ code: 'NATIVE_BUILD' }); expect(load).not.toHaveBeenCalled(); adapter.close();
});
it('caches a verified module instance, validates React and fails closed on unload', async () => {
  const load = vi.fn(async () => native()), adapter = createNativeReviewAdapter({ info: async () => info, load });
  await adapter.inspect(); await adapter.inspect(); expect(load).toHaveBeenCalledTimes(1); adapter.close(); await expect(adapter.inspect()).rejects.toMatchObject({ code: 'NATIVE_UNLOADED' });
  const changed = createNativeReviewAdapter({ info: async () => info, load: async () => ({ ...native(), hostReact: { ...React, useState: (() => {}) as any } }) });
  await expect(changed.inspect()).rejects.toMatchObject({ code: 'NATIVE_CONTRACT' }); changed.close();
});
it('late initialization after unload cannot attach or expose a new module instance', async () => {
  let release!: (value: NativeBuildInfo) => void; const infoWait = new Promise<NativeBuildInfo>(r => release = r); const load = vi.fn();
  const adapter = createNativeReviewAdapter({ info: () => infoWait, load }); const inspecting = adapter.inspect(); adapter.close(); release(info);
  await expect(inspecting).rejects.toMatchObject({ code: 'NATIVE_UNLOADED' }); expect(load).not.toHaveBeenCalled();
});
it('isolated display DTO is clearly owned and always disables native rollback', () => {
  const dto: any = nativeDisplayDto({ id: 'sample', path: 'D:/outside/a.txt', origin: 'external', additions: 1, deletions: 1, hunks: [], demo: true });
  expect(dto.id).toBe('diff-view-display:sample'); expect(dto.toolResult.details.pluginPresentation).toEqual({ owner: 'local.diff-view', origin: 'external', demo: true }); expect(dto.toolResult.details.review.reversible).toBe(false);
  expect(() => nativeDisplayDto({ id: 'huge', path: 'a', origin: 'external', additions: -1, deletions: 0, hunks: [] })).toThrow('Invalid');
});
