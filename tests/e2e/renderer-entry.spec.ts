import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
let host = '', entry = '';
test.beforeAll(async () => {
  host = (await build({ entryPoints: ['tests/e2e/renderer-entry-host.tsx'], bundle: true, format: 'iife', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0].text;
  entry = await fs.readFile('plugin/renderer/index.mjs', 'utf8');
});
async function setup(page: Page, query = '') {
  await page.route('**/renderer-entry-host*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><p>Production ESM with mocked 0.17.0 import map/SDK, not native acceptance.</p></body></html>' }));
  await page.route('**/production-renderer.mjs', route => route.fulfill({ contentType: 'text/javascript', body: entry }));
  await page.goto(`/renderer-entry-host${query}`); await page.addScriptTag({ content: host });
}
test('production ESM startup shows preflight using only the three supported host mappings', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.error || (window as any).__entryHost.loaded)).toBe(true);
  await expect(page.getByRole('button', { name: '原生审阅预检 / Native preflight' })).toBeVisible();
  await expect(page.getByRole('button', { name: '原生审阅预检 / Native preflight' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.reports.slice().sort())).toEqual(['bootstrap-ok', 'composer-mounted', 'entry-loaded']);
  expect(await page.evaluate(() => (window as any).__entryHost.slots)).toEqual(['entryExtra', 'composerControl']);
  const specifiers = [...entry.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.every(name => ['react', 'react-dom', 'react-dom/client'].includes(name))).toBe(true);
  expect(entry).not.toContain('from "react/jsx-runtime"');
  await page.getByRole('button', { name: '原生审阅预检 / Native preflight' }).click();
  await expect(page.getByRole('status')).toContainText('NATIVE_BUILD');
  await page.evaluate(() => (window as any).__entryHost.shutdown());
  await expect(page.locator('[data-test-slot]')).toHaveCount(0);
  expect(await page.evaluate(() => [(window as any).__entryHost.styles, (window as any).__entryHost.listeners])).toEqual([0, 0]);
});
test('preflight remains hidden when the option is explicitly off', async ({ page }) => {
  await setup(page, '?enabled=false'); await expect.poll(() => page.evaluate(() => (window as any).__entryHost.loaded)).toBe(true);
  await expect(page.getByRole('button', { name: '审阅更改', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.calls.filter((m: string) => m === 'jobPoll').length)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '原生审阅预检 / Native preflight' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__entryHost.shutdown());
});

test('a bootstrap failure leaves the entry visible and reports the reason instead of silently hiding it', async ({ page }) => {
  await setup(page, '?boot=fail'); await expect.poll(() => page.evaluate(() => (window as any).__entryHost.loaded)).toBe(true);
  await expect(page.getByRole('alert')).toContainText('Injected boot failure');
  await expect(page.getByRole('button', { name: '审阅更改', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.reports)).toContain('bootstrap-error');
  await page.evaluate(() => (window as any).__entryHost.shutdown());
});
