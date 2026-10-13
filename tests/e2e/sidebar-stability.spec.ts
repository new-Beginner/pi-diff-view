import { test, expect, type Page } from '@playwright/test';
// Production Panel + delayed mock bridge. Does not claim native-host acceptance.
const nonce = '00000000-0000-4000-8000-000000000789';
const sessionRoute = 'diff-session:session-a?sessionId=session-a';
const selectionRoute = `diff-view:${nonce}?sessionId=session-a`;
async function setup(page: Page, empty = false, paged = false) {
  await page.addInitScript(({ empty, paged, nonce }) => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value), demo = (window as any).__demo;
      demo.navigation.set(nonce, { nonce, revision: 1, sessionId: 'session-a', request: { scope: 'turn', root: 'D:/projects/diff-view', sessionId: 'session-a', runId: 'stable-run' }, fileId: 'created' });
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.review') {
          demo.polls = (demo.polls ?? 0) + 1;
          if (demo.polls > 1) await new Promise(resolve => setTimeout(resolve, 300));
          const result = await invoke(method, args, internal);
          result.runId = empty ? undefined : 'stable-run';
          if (!empty) result.run = { id: 'stable-run', sessionId: args.sessionId, root: result.root, startedAt: 1, state: 'running', fileCount: demo.extra ? 2 : 1, incomplete: false };
          result.files = empty ? [] : result.files.slice(0, demo.extra || paged ? 2 : 1);
          if (paged) { demo.remaining = result.files.slice(1); result.files = result.files.slice(0, 1); result.nextFileOffset = 1; }
          demo.review = { ...result, files: [...result.files, ...(paged ? demo.remaining : [])] };
          return result;
        }
        if (method === 'diff.reviewFiles') {
          await new Promise(resolve => setTimeout(resolve, 350));
          return { reviewId: args.reviewId, offset: args.offset, nextOffset: null, files: demo.remaining };
        }
        return invoke(method, args, internal);
      };
    } });
  }, { empty, paged, nonce });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent(sessionRoute));
  if (empty) await expect(page.locator('.dv-rail-empty')).toBeVisible();
  else await expect(page.locator('.dv-hunk')).toHaveCount(2);
}
const currentFileLoads = (page: Page) => page.evaluate(() => (window as any).__demo.calls.filter((c: any) => c.method === 'diff.file' && c.args.fileId === 'review').length);

test('idle empty scope never removes or hides its one empty-state node while polling', async ({ page }) => {
  await setup(page, true);
  await expect(page.getByText('此范围没有更改。', { exact: true })).toHaveCount(1);
  await page.evaluate(() => {
    const demo = (window as any).__demo, node = document.querySelector('.dv-rail-empty')!;
    demo.emptyFlicker = false;
    new MutationObserver(() => { if (!node.isConnected || node.getClientRects().length === 0) demo.emptyFlicker = true; }).observe(document.querySelector('.dv-app')!, { childList: true, subtree: true, attributes: true });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(4);
  expect(await page.evaluate(() => (window as any).__demo.emptyFlicker)).toBe(false);
  await expect(page.getByText('此范围没有更改。', { exact: true })).toHaveCount(1);
});

test('copy menus stay enabled and mounted during slow background updates, and both actions work', async ({ page }) => {
  await setup(page);
  const menu = page.locator('.dv-file-menu').first(); await menu.locator('summary').click();
  await expect(menu.getByRole('button', { name: '复制路径', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const demo = (window as any).__demo, menu = document.querySelector('.dv-file-menu')!, buttons = Array.from(menu.querySelectorAll('button')).slice(0, 3);
    demo.copyFlicker = false;
    new MutationObserver(() => { if (!menu.isConnected || buttons.some((b: any) => b.disabled)) demo.copyFlicker = true; }).observe(document.querySelector('.dv-app')!, { childList: true, subtree: true, attributes: true });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(4);
  expect(await page.evaluate(() => (window as any).__demo.copyFlicker)).toBe(false);
  await menu.getByRole('button', { name: '复制差异', exact: true }).click();
  await expect(page.getByText('差异已复制', { exact: true })).toBeVisible();
  await menu.getByRole('button', { name: '复制路径', exact: true }).click();
  await expect(page.getByText('路径已复制', { exact: true })).toBeVisible();
});

test('new files append without refetching unchanged selected diff or jumping the scroll position', async ({ page }) => {
  await setup(page); await expect.poll(() => currentFileLoads(page)).toBe(1);
  await page.evaluate(() => {
    const demo = (window as any).__demo;
    demo.hunk = document.querySelector('.dv-hunk'); demo.file = document.querySelector('.dv-file');
    const pane = document.querySelector('.dv-workspace')!; pane.scrollTop = 80; demo.scrollTop = pane.scrollTop;
    demo.extra = true;
  });
  await expect(page.locator('.dv-file')).toHaveCount(2);
  expect(await page.locator('.dv-file').evaluateAll(nodes => nodes.map(n => n.getAttribute('title')!.split(' · ')[0]))).toEqual(['session-a/src/review/index.ts', 'session-a/src/theme/index.ts']);
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(4);
  expect(await currentFileLoads(page)).toBe(1);
  expect(await page.evaluate(() => { const d = (window as any).__demo; return d.hunk === document.querySelector('.dv-hunk') && d.file === document.querySelector('.dv-file'); })).toBe(true);
  expect(await page.locator('.dv-workspace').evaluate(node => node.scrollTop)).toBe(await page.evaluate(() => (window as any).__demo.scrollTop));
});

test('Git round-trip reveals the existing session panel immediately, retaining selection and folds', async ({ page }) => {
  await setup(page);
  await page.locator('[data-hunk-nav]').first().click();
  await page.evaluate(() => { const d = (window as any).__demo; d.app = document.querySelector('.dv-app'); d.hunk = document.querySelector('.dv-hunk'); });
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.getByRole('region', { name: '本地 Git 管理' })).toBeVisible();
  await page.evaluate(() => { const d = (window as any).__demo; d.beforeReturn = d.calls.filter((c: any) => c.method === 'diff.bootstrap' && c.args.sessionId === 'session-a').length; });
  await page.getByRole('button', { name: '会话修改', exact: true }).click();
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/review/index.ts');
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => { const d = (window as any).__demo; return d.app === document.querySelector('.dv-app') && d.hunk === document.querySelector('.dv-hunk') && d.beforeReturn === d.calls.filter((c: any) => c.method === 'diff.bootstrap' && c.args.sessionId === 'session-a').length; })).toBe(true);
});

test('opening different card targets preserves the panel and the same chronological file order', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).__demo.extra = true; });
  await expect(page.locator('.dv-file')).toHaveCount(2);
  await page.evaluate(route => { const d = (window as any).__demo; d.app = document.querySelector('.dv-app'); d.openLocation(route); }, selectionRoute);
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/theme/index.ts');
  const order = await page.locator('.dv-file').evaluateAll(nodes => nodes.map(n => n.getAttribute('title')));
  await page.evaluate(({ nonce, route }) => { const d = (window as any).__demo, n = d.navigation.get(nonce); d.navigation.set(nonce, { ...n, revision: 2, fileId: 'review' }); d.openLocation(route); }, { nonce, route: selectionRoute });
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/review/index.ts');
  expect(await page.locator('.dv-file').evaluateAll(nodes => nodes.map(n => n.getAttribute('title')))).toEqual(order);
  expect(await page.evaluate(() => (window as any).__demo.app === document.querySelector('.dv-app'))).toBe(true);
});

test('paged background snapshots never drop the existing later file or its diff', async ({ page }) => {
  await setup(page, false, true);
  await expect(page.locator('.dv-file')).toHaveCount(2);
  await page.locator('.dv-file').nth(1).click();
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/theme/index.ts');
  await page.evaluate(() => {
    const d = (window as any).__demo, node = document.querySelector('.dv-file[aria-current="true"]')!, hunk = document.querySelector('.dv-hunk')!;
    d.pageFlicker = false;
    new MutationObserver(() => { if (!node.isConnected || !hunk.isConnected) d.pageFlicker = true; }).observe(document.querySelector('.dv-workspace')!, { childList: true, subtree: true });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(4);
  expect(await page.evaluate(() => (window as any).__demo.pageFlicker)).toBe(false);
  await expect(page.locator('.dv-file')).toHaveCount(2);
});

test('copy status expires after 3 seconds, repeat copies restart the timer without shifting files', async ({ page }) => {
  await setup(page);
  const menu = page.locator('.dv-file-menu').first();
  const copy = async () => { await menu.locator('summary').click(); await menu.getByRole('button', { name: '复制路径', exact: true }).click(); };
  const before = await page.locator('.dv-workspace').boundingBox();
  await copy();
  await expect(page.locator('.dv-toast')).toHaveText('路径已复制');
  expect(await page.locator('.dv-workspace').boundingBox()).toEqual(before);
  await page.waitForTimeout(2100); await copy(); await page.waitForTimeout(1200);
  await expect(page.locator('.dv-toast')).toBeVisible();
  await expect(page.locator('.dv-toast')).toHaveCount(0, { timeout: 3500 });
  expect(await page.locator('.dv-workspace').boundingBox()).toEqual(before);
});

test('transient selection polling failure retains the same app, file, folds and diff nodes', async ({ page }) => {
  await setup(page); await page.evaluate(route => { (window as any).__demo.extra = true; (window as any).__demo.openLocation(route); }, selectionRoute);
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/theme/index.ts');
  await page.locator('[data-hunk-nav]').first().click();
  await page.evaluate(() => {
    const d = (window as any).__demo, app = document.querySelector('.dv-app')!, file = document.querySelector('.dv-file')!, hunk = document.querySelector('.dv-hunk')!;
    d.selectionFlicker = false; d.failSelection = true;
    new MutationObserver(() => { if (!app.isConnected || !file.isConnected || !hunk.isConnected) d.selectionFlicker = true; }).observe(document.querySelector('.dv-panel')!, { childList: true, subtree: true });
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (method: string, args: any, internal: boolean) => method === 'diff.readTurnSelection' && d.failSelection ? Promise.reject(new Error('Transient navigation failure')) : invoke(method, args, internal);
  });
  await expect(page.getByRole('alert')).toContainText('Transient navigation failure');
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/theme/index.ts');
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { (window as any).__demo.failSelection = false; });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__demo.selectionFlicker)).toBe(false);
});
