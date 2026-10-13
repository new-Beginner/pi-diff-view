import { test, expect, type Page } from '@playwright/test';
// Production panel bundle with explicitly mocked history, not native-host acceptance.
async function setup(page: Page, unknown = false) {
  await page.addInitScript(({ unknown }) => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const original = value.invoke.bind(value);
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        const result = await original(method, args, internal);
        const demo = (window as any).__demo;
        if (method === 'diff.bootstrap') result.runs = []; // Captured after bootstrap's stale history page.
        if (method === 'diff.review') {
          result.runId = 'late-run';
          result.run = { id: result.runId, sessionId: args.sessionId, root: result.root, startedAt: 1750000100000, endedAt: 1750000101000, state: 'completed', fileCount: 1, incomplete: unknown };
          result.files = [{ ...result.files[0], path: `${args.sessionId}/late-run.ts`, kind: unknown ? 'unavailable' : 'text', statsKnown: !unknown, additions: unknown ? 0 : 3, deletions: unknown ? 0 : 2, actions: [] }];
          demo.review = result;
          if (args.sessionId === 'session-a' && demo.holdReview) {
            demo.waitingReview = true; await new Promise<void>(resolve => demo.releaseReview = resolve);
          }
        }
        return result;
      };
    } });
  }, { unknown });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent('diff-session:session-a?sessionId=session-a'));
}
test('latest view omits the turn dropdown; recorded turns include review-proven history after refresh', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-review h2')).toHaveText('session-a/late-run.ts');
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '范围', exact: true }).selectOption('turn');
  const turns = page.getByRole('combobox', { name: '对话轮次', exact: true });
  await expect(turns).toHaveValue('late-run'); await expect(turns).not.toContainText('暂无修改记录'); await expect(turns).toContainText('1 个文件');
  await page.getByTitle('显示设置', { exact: true }).click(); await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/late-run.ts'); await expect(turns).toHaveValue('late-run');
});
test('missing evidence is unknown at file and aggregate levels, never a complete +0 -0', async ({ page }) => {
  await setup(page, true); await expect(page.locator('.dv-file')).toContainText('行数未知');
  await expect(page.locator('.dv-heading .dv-counts')).toHaveText('行数未知');
  await expect(page.locator('.dv-added, .dv-deleted')).toHaveCount(0);
  await expect(page.locator('.dv-stats-note')).toContainText('1 个文件暂无法显示行数');
  await expect(page.locator('.dv-stats-note p')).toBeHidden();
  await page.locator('.dv-stats-note summary').click(); await expect(page.locator('.dv-stats-note p')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toHaveCount(0);
});
test('a late review cannot overwrite the files or turn dropdown after switching session', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-review h2')).toHaveText('session-a/late-run.ts');
  await page.evaluate(() => { (window as any).__demo.holdReview = true; });
  await page.getByTitle('显示设置', { exact: true }).click(); await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__demo.waitingReview)).toBe(true);
  await page.evaluate(() => (window as any).__demo.openLocation('diff-session:session-b?sessionId=session-b'));
  await expect(page.locator('.dv-review:visible h2')).toHaveText('session-b/late-run.ts');
  await page.evaluate(() => { const demo = (window as any).__demo; demo.holdReview = false; demo.releaseReview(); });
  await page.waitForTimeout(400); await expect(page.locator('.dv-file:visible')).not.toContainText('session-a/');
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toHaveCount(0);
});
