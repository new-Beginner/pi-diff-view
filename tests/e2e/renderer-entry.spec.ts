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
test('production ESM uses supported host mappings and registers only the reply-end slot', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.error || (window as any).__entryHost.loaded)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.reports.slice().sort())).toEqual(['bootstrap-ok', 'entry-loaded', 'reply-slot-mounted']);
  expect(await page.evaluate(() => (window as any).__entryHost.slots)).toEqual(['entryExtra']);
  await expect(page.locator('[data-test-slot="composerControl"]')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__entryHost.calls)).not.toContain('nativeProbeInfo');
  const specifiers = [...entry.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.every(name => ['react', 'react-dom', 'react-dom/client'].includes(name))).toBe(true);
  expect(entry).not.toContain('from "react/jsx-runtime"');
  await page.evaluate(() => (window as any).__entryHost.shutdown());
  await expect(page.locator('[data-test-slot]')).toHaveCount(0);
  expect(await page.evaluate(() => [(window as any).__entryHost.styles, (window as any).__entryHost.listeners])).toEqual([0, 0]);
});
test('removing composer controls does not depend on the old native-preflight setting', async ({ page }) => {
  await setup(page, '?enabled=false'); await expect.poll(() => page.evaluate(() => (window as any).__entryHost.loaded)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.reports)).toContain('bootstrap-ok');
  expect(await page.evaluate(() => (window as any).__entryHost.slots)).toEqual(['entryExtra']);
  await expect(page.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => (window as any).__entryHost.shutdown());
});
test('a bootstrap failure is diagnosed without reintroducing input-area controls', async ({ page }) => {
  await setup(page, '?boot=fail'); await expect.poll(() => page.evaluate(() => (window as any).__entryHost.loaded)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__entryHost.reports)).toContain('card-query-error');
  expect(await page.evaluate(() => (window as any).__entryHost.slots)).toEqual(['entryExtra']);
  await expect(page.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => (window as any).__entryHost.shutdown());
});
