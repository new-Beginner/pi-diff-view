import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
it('built main records only bounded renderer startup stages and rejects arbitrary stage keys', async () => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'renderer-status-'));
  const data = path.join(root, 'data'), entry = path.join(root, 'main.cjs');
  await build({ entryPoints: ['src/main.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['original-fs'] });
  const home = vi.spyOn(os, 'homedir').mockReturnValue(root), oldPi = (globalThis as any).pi;
  (globalThis as any).pi = { plugin: { getDataPath: async () => data, getSettings: async () => ({}) }, workspace: { get: async () => null }, app: { getAppearance: async () => ({}) }, commands: { register: async () => {}, unregister: async () => {} }, events: { on() {}, off() {} } };
  const plugin = createRequire(import.meta.url)(entry); let loaded = false;
  try {
    await plugin.onLoad(); loaded = true;
    expect(JSON.parse(await fs.readFile(path.join(data, 'renderer-status.json'), 'utf8')).stages).toEqual({});
    await plugin.onRendererCall('rendererReport', { stage: 'entry-loaded', content: 'should never be recorded', sessionId: 'not stored' });
    await plugin.onRendererCall('rendererReport', { stage: 'sidebar-opened' });
    await expect(plugin.onRendererCall('rendererReport', { stage: '../outside' })).rejects.toThrow('Unknown');
    await expect(plugin.onRendererCall('rendererReport', null)).rejects.toThrow('Unknown');
    const text = await fs.readFile(path.join(data, 'renderer-status.json'), 'utf8'), value = JSON.parse(text);
    expect(Object.keys(value.stages)).toEqual(['entry-loaded', 'sidebar-opened']);
    expect(Object.values(value.stages).every(timestamp => Number.isFinite(timestamp))).toBe(true);
    expect(text).not.toContain('should never'); expect(text).not.toContain('not stored');
    await plugin.onUnload(); loaded = false;
    await expect(plugin.onRendererCall('rendererReport', { stage: 'entry-loaded' })).rejects.toThrow('not loaded');
  } finally { if (loaded) await plugin.onUnload(); home.mockRestore(); (globalThis as any).pi = oldPi; await fs.rm(root, { recursive: true, force: true }); }
});
