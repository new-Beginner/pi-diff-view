import { test, expect } from '@playwright/test';

// Production panel; simulated backend latency and changes, not native-host acceptance.
async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value);
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.review') {
          const demo = (window as any).__demo;
          demo.polls = (demo.polls ?? 0) + 1;
          if (demo.polls > 1) await new Promise(resolve => setTimeout(resolve, demo.reviewDelay ?? 200));
          const result = await invoke(method, args, internal);
          result.runId = 'live-run';
          result.run = { id: 'live-run', sessionId: args.sessionId, root: result.root, startedAt: 1, state: demo.completed ? 'completed' : 'running', fileCount: demo.extra ? 2 : 1, incomplete: false };
          result.files = result.files.slice(0, demo.extra ? 2 : 1);
          if (demo.extra) result.files[0] = { ...result.files[0], fingerprint: 'changed', additions: 4 };
          demo.review = result;
          return result;
        }
        if (method === 'diff.file' && (window as any).__demo.polls > 1) await new Promise(resolve => setTimeout(resolve, 200));
        return invoke(method, args, internal);
      };
    } });
  });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent('diff-session:session-a?sessionId=session-a'));
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
}

test('polling keeps file and diff nodes mounted, retains folding and updates changed files', async ({ page }) => {
  await setup(page);
  await page.locator('[data-hunk-nav]').first().click();
  await page.evaluate(() => {
    const demo = (window as any).__demo;
    demo.originalFile = document.querySelector('.dv-file');
    demo.originalHunk = document.querySelector('.dv-hunk');
    demo.removed = false;
    new MutationObserver(() => {
      if (!demo.originalFile.isConnected || !demo.originalHunk.isConnected) demo.removed = true;
    }).observe(document.querySelector('.dv-workspace')!, { childList: true, subtree: true });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(4);
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { (window as any).__demo.extra = true; });
  await expect(page.locator('.dv-file')).toHaveCount(2);
  await expect(page.locator('.dv-file').first()).toContainText('+4');
  await expect(page.locator('[data-hunk-nav]').first()).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => (window as any).__demo.removed)).toBe(false);
});

test('latest view keeps polling after completion and does not cancel a slow pending review', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { const demo = (window as any).__demo; demo.completed = true; demo.reviewDelay = 1100; });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.polls)).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => { (window as any).__demo.extra = true; });
  await expect(page.locator('.dv-file')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toHaveCount(0);
});
