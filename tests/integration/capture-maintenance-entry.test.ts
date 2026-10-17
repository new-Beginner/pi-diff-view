import fs from 'node:fs/promises';
import { expect, it } from 'vitest';

it('exposes an explicit legacy capture-lease maintenance entry', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../../plugin/manifest.json', import.meta.url), 'utf8'));
  const app = await fs.readFile(new URL('../../src/view/ReviewApp.tsx', import.meta.url), 'utf8');
  expect(manifest.rendererCallMethods).toContain('captureMaintenance');
  expect(app).toContain('采集维护/旧租约');
  expect(app).toContain('旧写入任务及后台进程已停止');
});
