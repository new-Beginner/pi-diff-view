import { test, expect, type Page } from '@playwright/test';
const nonce = '00000000-0000-4000-8000-000000000456';
async function setup(page: Page, initial: 'pending' | 'ready' | 'unavailable') {
  await page.addInitScript(({ initial, nonce }) => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value), demo = (window as any).__demo;
      demo.syncState = initial; demo.reviewCount = 0;
      demo.navigation.set(nonce, { nonce, revision: 1, sessionId: 'session-a', request: { scope: 'turn', root: 'D:/projects/diff-view', sessionId: 'session-a', runId: 'saved-run' }, fileId: 'review' });
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method !== 'diff.review') return invoke(method, args, internal);
        demo.reviewCount++;
        if (args.retrySync) demo.syncState = 'ready';
        const result = await invoke(method, args, internal);
        result.runId = 'saved-run'; result.run = { id: 'saved-run', sessionId: args.sessionId, root: result.root, startedAt: 1, state: 'completed', fileCount: 1, incomplete: false };
        result.sync = { state: demo.syncState }; result.files = result.files.slice(0, 1);
        if (demo.syncState === 'pending') result.files = result.files.map((file: any) => ({ ...file, kind: 'unavailable', statsKnown: false, additions: 0, deletions: 0 }));
        if (demo.genuinelyUnknown) result.files[0] = { ...result.files[0], kind: 'unavailable', statsKnown: false, additions: 0, deletions: 0, actions: [] };
        demo.review = result; return result;
      };
    } });
  }, { initial, nonce });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent(`diff-view:${nonce}?sessionId=session-a`));
}
test('cold pinned completed history stays syncing, then updates without a sidebar round-trip', async ({ page }) => {
  await setup(page, 'pending');
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toBeVisible();
  await expect(page.locator('.dv-file')).toHaveCount(0);
  await expect(page.getByText('行数未知', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__demo.reviewCount)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { (window as any).__demo.syncState = 'ready'; });
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toHaveCount(0);
});
test('sync timeout is actionable and manual retry restarts preparation', async ({ page }) => {
  await setup(page, 'unavailable');
  await expect(page.getByText('修改记录同步未完成；当前仅展示已保存记录，可重试。', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => (window as any).__demo.reviewCount);
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (window as any).__demo.reviewCount)).toBe(before);
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('修改记录同步未完成；当前仅展示已保存记录，可重试。', { exact: true })).toHaveCount(0);
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
});
test('ready evidence still displays genuinely unknown file statistics', async ({ page }) => {
  await setup(page, 'pending');
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toBeVisible();
  await page.evaluate(() => { const d = (window as any).__demo; d.genuinelyUnknown = true; d.syncState = 'ready'; });
  await expect(page.locator('.dv-file')).toHaveCount(1);
  await expect(page.locator('.dv-file').getByText('行数未知', { exact: true })).toBeVisible();
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toHaveCount(0);
});
test('background preparation retains the selected file, folded hunks and DOM nodes', async ({ page }) => {
  await setup(page, 'ready'); await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await page.locator('[data-hunk-nav]').first().click();
  await page.evaluate(() => { const d = (window as any).__demo; d.fileNode = document.querySelector('.dv-file'); d.hunkNode = document.querySelector('.dv-hunk'); d.syncState = 'pending'; });
  // Reactivation requests a refresh even for a pinned completed task.
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await page.getByRole('button', { name: '会话修改', exact: true }).click();
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toBeVisible();
  await expect(page.locator('.dv-file')).toHaveCount(1);
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => { const d = (window as any).__demo; return d.fileNode === document.querySelector('.dv-file') && d.hunkNode === document.querySelector('.dv-hunk'); })).toBe(true);
  await page.evaluate(() => { (window as any).__demo.syncState = 'ready'; });
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
});
test('pending automatically times out after 15 seconds and stops polling until retry', async ({ page }) => {
  await page.clock.install();
  await setup(page, 'pending');
  await expect(page.getByText('正在同步修改记录…', { exact: true })).toBeVisible();
  await page.clock.setSystemTime(new Date(Date.now() + 16000));
  await expect(page.getByText('修改记录同步未完成；当前仅展示已保存记录，可重试。', { exact: true })).toBeVisible();
  const count = await page.evaluate(() => (window as any).__demo.reviewCount);
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (window as any).__demo.reviewCount)).toBe(count);
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.getByText('修改记录同步未完成；当前仅展示已保存记录，可重试。', { exact: true })).toHaveCount(0);
});
