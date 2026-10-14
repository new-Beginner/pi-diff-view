import { expect, type Locator } from '@playwright/test';
export async function selectScope(trigger: Locator, value: string) {
  await trigger.click();
  await trigger.locator('..').locator(`[role="option"][data-value="${value}"]`).click();
  await expect(trigger).toHaveAttribute('data-value', value);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
