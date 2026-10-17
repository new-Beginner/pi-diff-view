import { test, expect } from '@playwright/test';

for (const lang of ['en', 'zh-CN']) test(`session file toolbar toggles all collapsed, mixed and all expanded (${lang})`, async ({ page }) => {
  await page.goto(`/review-component/?lang=${lang}`);
  const files = page.locator('.dv-file');
  await expect(files).toHaveCount(10);
  const expanded = page.locator('.dv-file[aria-expanded="true"]');
  const collapse = page.getByRole('button', { name: lang === 'en' ? 'Collapse all files' : '折叠全部文件', exact: true });
  const expand = page.getByRole('button', { name: lang === 'en' ? 'Expand all files' : '展开全部文件', exact: true });
  await expect(expanded).toHaveCount(1);
  await collapse.click();
  await expect(expanded).toHaveCount(0);
  await expect(expand).toBeEnabled();
  await expand.click();
  await expect(expanded).toHaveCount(10);
  await expect(page.locator('.dv-file-section > .dv-review:visible')).toHaveCount(10);
  await collapse.click();
  await expect(expanded).toHaveCount(0);
  await expand.click();
  await files.nth(1).click();
  await expect(expanded).toHaveCount(9);
  await files.nth(1).click();
  await expect(expanded).toHaveCount(10);
  await files.nth(1).click();
  await expect(expanded).toHaveCount(9);
  await collapse.click();
  await expect(expanded).toHaveCount(0);
  await files.nth(1).click();
  await expect(expanded).toHaveCount(1);
  await collapse.click();
  await expect(expanded).toHaveCount(0);
});

test('session expansion covers only matching files and is disabled for an empty search', async ({ page }) => {
  await page.goto('/review-component/?lang=en');
  await expect(page.locator('.dv-file')).toHaveCount(10);
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await page.getByRole('button', { name: 'Search file paths', exact: true }).click();
  await page.getByRole('searchbox').fill('src/theme');
  await expect(page.locator('.dv-file')).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand all files', exact: true }).click();
  await expect(page.locator('.dv-file[aria-expanded="true"]')).toHaveCount(1);
  await page.getByRole('searchbox').fill('no-matching-file');
  await expect(page.getByRole('button', { name: 'Expand all files', exact: true })).toBeDisabled();
});

test('expand-all renders non-current file content and collapsing does not resurrect it', async ({ page }) => {
  await page.goto('/review-component/?lang=en');
  await expect(page.locator('.dv-file')).toHaveCount(10);
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await page.getByRole('button', { name: 'Expand all files', exact: true }).click();
  const created = page.locator('.dv-file-section').filter({ has: page.locator('.dv-file').filter({ hasText: 'src/theme/index.ts' }) });
  await created.scrollIntoViewIfNeeded();
  await expect(created.locator('.dv-row')).toHaveCount(3);
  await expect(created.locator('.dv-number[data-side="old"]')).toHaveCount(0);
  await expect(created.locator('.dv-diff-pane')).toHaveAttribute('aria-label', /src\/theme\/index\.ts/);
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await expect(page.locator('.dv-file[aria-expanded="true"]')).toHaveCount(0);
  await expect(created.locator('.dv-review')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand all files', exact: true })).toBeEnabled();
});
