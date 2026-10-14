import { test, expect, type Locator } from '@playwright/test';
import path from 'node:path';
import { selectScope } from './scope-helpers';

async function checkMenu(menu: Locator, width: number) {
  await expect(menu).toBeVisible();
  const style = await menu.evaluate(node => {
    const css = getComputedStyle(node), bounds = node.getBoundingClientRect();
    return { radius: css.borderRadius, shadow: css.boxShadow, left: bounds.left, right: bounds.right, overflow: node.scrollWidth > node.clientWidth };
  });
  expect(style.radius).toBe('16px'); expect(style.shadow).not.toBe('none');
  expect(style.left).toBeGreaterThanOrEqual(0); expect(style.right).toBeLessThanOrEqual(width);
  expect(style.overflow).toBe(false);
  const item = menu.locator(':scope > button').first();
  expect(await item.evaluate(node => getComputedStyle(node).borderRadius)).toBe('8px');
  const before = await item.evaluate(node => getComputedStyle(node).backgroundColor);
  await item.hover();
  expect(await item.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(before);
}

for (const width of [560, 380]) for (const base of ['light', 'dark']) test(`scope/settings/file menus share restrained styling (${width}px ${base})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/review-component/?scenario=renderer&session=session-demo&lang=zh-CN&base=${base}`);
  const scope = page.getByRole('combobox', { name: '范围', exact: true });
  await selectScope(scope, 'lastTurn');
  await expect(page.locator('.dv-turn-identity')).toHaveCount(0);
  await expect(page.locator('.dv-repo-toolbar')).not.toBeVisible();
  await scope.click();
  const options = page.getByRole('listbox');
  await checkMenu(options, width);
  await expect(options.getByRole('option')).toHaveCount(2);
  await expect(options.getByRole('option', { selected: true })).toHaveText('最近轮次');
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PI_SCRATCH_DIR!, `menus-${width}-${base}-scope.png`) });
  await page.keyboard.press('Escape'); await expect(options).toHaveCount(0); await expect(scope).toBeFocused();
  await page.getByTitle('显示设置', { exact: true }).click();
  const settings = page.locator('.dv-settings-menu > .dv-menu-body');
  await checkMenu(settings, width);
  const aligned = await settings.locator('.dv-check').evaluate(node => {
    const input = node.querySelector('input')!.getBoundingClientRect(), label = node.getBoundingClientRect();
    return input.left - label.left;
  });
  expect(aligned).toBe(10);
  await expect(settings.getByRole('checkbox', { name: '自动换行' })).toBeChecked();
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PI_SCRATCH_DIR!, `menus-${width}-${base}-settings.png`) });
  await page.keyboard.press('Escape'); await expect(settings).not.toBeVisible();
  const file = page.locator('.dv-file').filter({ hasText: '…/review-summary.md' }), row = file.locator('..');
  const positions = () => row.evaluate(node => ['.dv-counts', '.dv-file-open', '.dv-file-menu'].map(selector => node.querySelector(selector)!.getBoundingClientRect().x));
  const before = await positions();
  await row.locator('.dv-file-menu summary').click();
  const fileMenu = row.locator('.dv-menu-body');
  await checkMenu(fileMenu, width); expect(await positions()).toEqual(before);
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PI_SCRATCH_DIR!, `menus-${width}-${base}-file.png`) });
  await scope.click(); await expect(fileMenu).not.toBeVisible();
  await page.locator('.dv-top-actions').click(); await expect(options).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('scope keyboard navigation selects only on confirmation and restores focus', async ({ page }) => {
  await page.goto('/review-component/');
  const scope = page.getByRole('combobox', { name: 'Scope', exact: true });
  await expect(scope).toBeEnabled(); await expect(scope).toHaveAttribute('data-value', 'unstaged');
  await scope.focus(); await page.keyboard.press('ArrowDown');
  const options = page.getByRole('listbox').getByRole('option');
  const selected = page.getByRole('listbox').getByRole('option', { selected: true });
  await expect(selected).toBeFocused();
  await page.keyboard.press('Home'); await expect(options.first()).toBeFocused();
  await page.keyboard.press('End'); await expect(options.last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(options.first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(options.last()).toBeFocused();
  await expect(scope).toHaveAttribute('data-value', 'unstaged');
  await page.keyboard.press('Escape'); await expect(scope).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await expect(scope).toHaveAttribute('data-value', 'lastTurn'); await expect(scope).toBeFocused();
  await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await expect(scope).toHaveAttribute('data-value', 'turn');
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toBeVisible();
  await scope.click(); await page.keyboard.press('Tab'); await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('scope remains disabled on bootstrap failure and obeys host theme tokens', async ({ page }) => {
  await page.goto('/review-component/?scenario=boot-error');
  await expect(page.getByRole('combobox', { name: 'Scope', exact: true })).toBeDisabled();
  await page.goto('/review-component/?lang=zh-CN');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ds-bg-elevated-opaque', '#f1f2f3');
    document.documentElement.style.setProperty('--ds-bg-hover', '#e1e2e3');
  });
  await page.getByRole('combobox', { name: '范围', exact: true }).click();
  expect(await page.getByRole('listbox').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(241, 242, 243)');
  const first = page.getByRole('listbox').getByRole('option').first(); await first.hover();
  expect(await first.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(225, 226, 227)');
});
