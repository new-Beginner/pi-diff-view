import { test, expect } from '@playwright/test';

test('external files show ellipsis and basename while retaining full-path tooltip', async ({ page }) => {
  await page.goto('/review-component/?scenario=renderer&session=session-demo&lang=zh-CN');
  const external = page.locator('.dv-file').filter({ hasText: '…/review-summary.md' });
  await expect(external).toHaveCount(1);
  await expect(external.locator('.dv-file-name')).toHaveText('…/review-summary.md');
  await expect(external).toHaveAttribute('title', /D:\/notes\/review-summary\.md/);
  await expect(page.locator('.dv-file-name').filter({ hasText: 'src/review/index.ts' }).first()).toHaveText('src/review/index.ts');
  await page.setViewportSize({ width: 380, height: 800 });
  await expect(external.locator('.dv-file-name')).toHaveText('…/review-summary.md');
  expect(await external.locator('.dv-file-name').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
