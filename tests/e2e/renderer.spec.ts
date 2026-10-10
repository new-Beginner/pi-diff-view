import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
let harness = '';
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/e2e/renderer-harness.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, loader: { '.css': 'empty' } });
  harness = result.outputFiles[0].text;
});
async function setup(page: Page) {
  await page.route('**/renderer-demo', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/mock.js"></script><style>body{margin:0;font:13px system-ui;background:#fff}</style></head><body><p>Demo renderer SDK · not the actual host</p></body></html>' }));
  await page.goto('/renderer-demo'); await page.addScriptTag({ content: harness });
  await expect(page.locator('.dv-reply')).toHaveCount(1);
}
test('mocked renderer shares polling, opens selected-run layer, and cleans timers/styles/slots/layers', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate(() => (window as any).__rendererDemo.positions)).toContainEqual({ slot: 'composerControl', positions: ['right'] });
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.card').length)).toBeLessThanOrEqual(2);
  await page.locator('.dv-composer').click();
  await expect(page.locator('.dv-layer .dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-layer').getByRole('combobox', { name: 'Scope' })).toHaveValue('unstaged');
  await page.keyboard.press('Escape'); await expect(page.locator('.dv-layer')).toHaveCount(0);
  await page.locator('.dv-reply').getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('.dv-layer .dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-layer').getByRole('combobox', { name: 'Scope' })).toHaveValue('turn');
  const reviewCall = await page.evaluate(() => (window as any).__demo.calls.find((call: any) => call.method === 'diff.review' && call.args.runId === 'run-demo'));
  expect(reviewCall.args).toMatchObject({ sessionId: 'session-demo', runId: 'run-demo', scope: 'turn' });
  const logs = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method.startsWith('diff.') && !call.internal));
  for (let i = 1; i < logs.length; i++) expect(logs[i].at - logs[i - 1].at).toBeGreaterThanOrEqual(140);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-layer, .dv-reply, .dv-composer')).toHaveCount(0);
  expect(await page.evaluate(() => { const state = (window as any).__rendererDemo; return [state.styles, state.layers, state.subscriptions]; })).toEqual([0, 0, 0]);
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (window as any).__demo.calls.length);
  await page.waitForTimeout(6400);
  expect(await page.evaluate(() => (window as any).__demo.calls.length)).toBe(before);
});

test('ready feedback inserts synchronously under gesture/session guard and preserves existing draft', async ({ page }) => {
  await setup(page);
  await page.locator('.dv-reply').getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('.dv-layer .dv-hunk')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add comment: New 2', exact: true }).click();
  await page.locator('dialog').getByRole('textbox', { name: 'Comment', exact: true }).fill('Keep this change scoped.');
  await page.locator('dialog').getByRole('button', { name: 'Save comment' }).click();
  await page.locator('.dv-feedback > summary').click();
  const insert = page.getByRole('button', { name: 'Insert feedback into draft' }); await expect(insert).toBeEnabled();
  await insert.click();
  const state = await page.evaluate(() => (window as any).__rendererDemo);
  expect(state.draft).toMatch(/^Existing draft\. /); expect(state.draft).toContain('Keep this change scoped.');
  expect(state.inserts).toHaveLength(1); expect(state.inserts[0]).toMatchObject({ sessionId: 'session-demo', gesture: true });
  const count = state.inserts.length;
  await page.evaluate(() => (window as any).__rendererDemo.switchSession('other-session'));
  await expect(page.locator('.dv-layer')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__rendererDemo.inserts.length)).toBe(count);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
