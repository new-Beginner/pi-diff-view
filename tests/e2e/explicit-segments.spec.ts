import { test, expect } from '@playwright/test';

test('discontinuous snapshots display read-only segments instead of hiding available diffs', async ({ page }) => {
  await page.goto('/review-component/?scenario=segmented&session=session-demo&lang=zh-CN');
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('2 段 · 净行数未知');
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-hunk-heading').first()).toContainText('分段 1');
  await expect(page.locator('.dv-hunk-heading').nth(1)).toContainText('分段 2');
  await expect(page.locator('.dv-add').first()).toContainText('after segment 1');
  await expect(page.locator('.dv-add').nth(1)).toContainText('after segment 2');
  const menu = page.locator('.dv-file-row:has(.dv-file[aria-current="true"]) .dv-file-menu');
  await menu.locator('summary').click();
  await expect(menu.getByRole('button', { name: '复制差异', exact: true })).toBeDisabled();
  await expect(menu.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
  await expect(menu).toContainText('分段只读');
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => ['diff.action', 'diff.copyPatch'].includes(call.method)).length)).toBe(0);
});
