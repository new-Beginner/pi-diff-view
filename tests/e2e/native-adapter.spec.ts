import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
let harness = '';
test.beforeAll(async () => { const output = await build({ entryPoints: ['tests/e2e/native-harness.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false }); harness = output.outputFiles[0].text; });
async function setup(page: Page) { await page.route('**/native-adapter-demo', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><p>Mock native adapter contracts, not actual host</p></body></html>' })); await page.goto('/native-adapter-demo'); await page.addScriptTag({ content: harness }); }
test('mock native pane opens, exact snapshot locates, external display is readonly and messages stay unchanged', async ({ page }) => {
  await setup(page); const evidence = await page.evaluate(() => (window as any).__nativeProbe.probe());
  expect(evidence).toEqual({ opened: true, located: true, externalRendered: true, readonly: true, sessionGuard: true });
  await expect(page.locator('#work-panel-surface-review .review-scroll > section.review-change-card > .review-change-card-body')).toBeVisible();
  await expect(page.locator('[data-diff-view-native-supplement]')).toContainText('External-file demo');
  await expect(page.locator('[data-diff-view-native-supplement] .review-change-diff')).toContainText('after demo');
  await expect(page.locator('[data-diff-view-native-supplement] .review-change-rollback')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__nativeProbe.unchanged())).toBe(true);
  await page.evaluate(() => (window as any).__nativeProbe.close());
  await expect(page.locator('[data-diff-view-native-supplement]')).toHaveCount(0);
  await expect(page.locator('#work-panel-surface-review .review-scroll .review-change-card')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__nativeProbe.subscriptions())).toBe(0);
});
for (const action of ['switchSession', 'closeTab']) test(`mock ${action} removes owned region and subscription`, async ({ page }) => {
  await setup(page); await page.evaluate(() => (window as any).__nativeProbe.probe());
  await page.evaluate(action => (window as any).__nativeProbe[action](), action);
  await expect(page.locator('[data-diff-view-native-supplement]')).toHaveCount(0); expect(await page.evaluate(() => (window as any).__nativeProbe.subscriptions())).toBe(0);
});
test('different/transitioning sessions and running Agents are refused before opening the pane', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__nativeProbe.state.selectingSessionId = 's'; });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_SESSION');
  await page.evaluate(() => { (window as any).__nativeProbe.state.selectingSessionId = null; });
  const result = await page.evaluate(async () => { const p = (window as any).__nativeProbe; try { await p.probe('other'); } catch (e: any) { return e.code; } }); expect(result).toBe('NATIVE_SESSION');
  await page.evaluate(() => { (window as any).__nativeProbe.state.isRunning = true; });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_RUNNING');
  expect(await page.evaluate(() => (window as any).__nativeProbe.state.opens)).toBe(0);
});
test('unknown builds never load internal modules or open anything', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).__nativeProbe.state.infoVersion = '0.18.0'; });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_BUILD');
  expect(await page.evaluate(() => [(window as any).__nativeProbe.state.loads, (window as any).__nativeProbe.state.opens])).toEqual([0, 0]);
});
test('unexpected native rollback control aborts and cleans only the owned display', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).__nativeProbe.state.reversibleComponent = true; });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_READONLY');
  await expect(page.locator('[data-diff-view-native-supplement]')).toHaveCount(0); expect(await page.evaluate(() => (window as any).__nativeProbe.subscriptions())).toBe(0); expect(await page.evaluate(() => (window as any).__nativeProbe.unchanged())).toBe(true);
});
test('missing native disclosure times out with a specific error and cleans the owned region', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).__nativeProbe.state.missingComponent = true; });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_SURFACE');
  await expect(page.locator('[data-diff-view-native-supplement]')).toHaveCount(0); expect(await page.evaluate(() => (window as any).__nativeProbe.subscriptions())).toBe(0);
});
test('concurrent preflights are refused and component exceptions do not escape the owned root', async ({ page }) => {
  await setup(page);
  const results = await page.evaluate(async () => { const p = (window as any).__nativeProbe; return Promise.all([p.probe().then(() => 'done'), p.probe().catch((e: any) => e.code)]); });
  expect(results).toEqual(['done', 'NATIVE_BUSY']); expect(await page.evaluate(() => (window as any).__nativeProbe.state.opens)).toBe(1);
  await page.evaluate(() => { const p = (window as any).__nativeProbe; p.reset(); p.failRender(); });
  expect(await page.evaluate(async () => { try { await (window as any).__nativeProbe.probe(); } catch (e: any) { return e.code; } })).toBe('NATIVE_RENDER');
  await expect(page.locator('[data-diff-view-native-supplement]')).toHaveCount(0); expect(await page.evaluate(() => (window as any).__nativeProbe.subscriptions())).toBe(0);
});
