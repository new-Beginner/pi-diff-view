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

for (const width of [560, 380]) test(`file statistics and actions stay aligned through selection and collapse (${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/review-component/?scenario=renderer&session=session-demo&lang=zh-CN');
  const file = page.locator('.dv-file').filter({ hasText: '…/review-summary.md' });
  await expect(file).toBeVisible();
  const row = file.locator('..');
  const positions = () => row.evaluate(node => ['.dv-counts', '.dv-file-open', '.dv-file-menu'].map(selector => node.querySelector(selector)!.getBoundingClientRect().x));
  const before = await positions();
  await file.click(); await expect(file).toHaveAttribute('aria-expanded', 'true');
  expect(await positions()).toEqual(before);
  await file.click(); await expect(file).toHaveAttribute('aria-expanded', 'false');
  expect(await positions()).toEqual(before);
  await expect(page.locator('.dv-file-collapse')).toHaveCount(0);
  await file.click(); await expect(file).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '折叠文件', exact: true }).click();
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  expect(await positions()).toEqual(before);
});
