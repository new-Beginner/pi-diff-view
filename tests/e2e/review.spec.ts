import { test, expect, type Page } from '@playwright/test';
const ready = async (page: Page, query = '') => { await page.goto(`/${query}`); await expect(page.locator('.dv-hunk')).toHaveCount(2); };
const calls = async (page: Page, method: string) => page.evaluate(method => (window as any).__demo.calls.filter((call: any) => call.method === method), method);

test('file paths disambiguate; newly created file has only new line numbers', async ({ page }) => {
  await ready(page);
  await expect(page.getByText('Demo data · mocked backend / 演示数据 · 模拟后端')).toBeVisible();
  await page.getByRole('searchbox').fill('src/theme');
  await expect(page.locator('.dv-file')).toHaveCount(1);
  await page.locator('.dv-file').click();
  await expect(page.getByRole('heading', { name: 'src/theme/index.ts' })).toBeVisible();
  await expect(page.locator('.dv-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Add comment: Old', exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add comment: New 1', exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('nothing-matches');
  await expect(page.getByText('No matching paths.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.dv-file')).toHaveCount(10);
});

test('split rows align; syntax and changed words survive wrap; context disables hunk actions', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.hljs-keyword').first()).toBeVisible();
  await expect(page.locator('mark.dv-word').first()).toBeVisible();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.locator('.dv-split')).toHaveCount(2);
  const alignment = await page.locator('.dv-pair').evaluateAll(rows => rows.every(row => { const [a, b] = [...row.children].map(node => node.getBoundingClientRect()); return a.top === b.top && a.height === b.height && a.right <= b.left + 1; }));
  expect(alignment).toBe(true);
  await page.getByRole('checkbox', { name: 'Wrap lines' }).uncheck();
  expect(await page.locator('.dv-diff-pane').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.getByRole('checkbox', { name: 'Wrap lines' }).check();
  expect(await page.locator('.dv-diff-pane').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.getByRole('combobox', { name: 'Context' }).selectOption('20');
  await expect(page.locator('.dv-hunk')).toHaveCount(1);
  await expect(page.locator('.dv-hunk-heading').getByRole('button', { name: 'Stage', exact: true })).toHaveCount(0);
  await expect(page.getByText('Hunk operations are available only', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Context' }).selectOption('-1');
  await expect(page.locator('.dv-row, .dv-side')).not.toHaveCount(0);
  await expect(page.locator('.dv-pagination')).toContainText('1–80');
  expect((await calls(page, 'diff.file')).at(-1).args.context).toBe(-1);
});

test('old/new comments store fingerprints/excerpts; edit, stale warning, delete, feedback', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Add comment: Old 2', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save comment' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Comment', exact: true }).fill('Prefer explicit context bounds.');
  await dialog.getByRole('button', { name: 'Save comment' }).click();
  await expect(page.locator('.dv-comment')).toHaveCount(1);
  const saved = (await calls(page, 'diff.saveComment'))[0].args;
  expect(saved.anchor).toMatchObject({ side: 'old', line: 2, path: 'src/review/index.ts', fingerprint: 'version-review', text: '  const context = 3;' });
  expect(saved.anchor.excerpt).toContain('return context');
  await expect(page.locator('.dv-stale')).toHaveCount(0);
  await page.locator('.dv-comment').getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Comment', exact: true }).fill('Edited review feedback.');
  await dialog.getByRole('button', { name: 'Save comment' }).click();
  await expect(page.locator('.dv-comment')).toContainText('Edited review feedback.');
  await page.locator('.dv-feedback > summary').click();
  await expect(page.getByRole('textbox', { name: 'Select and copy feedback' })).toHaveValue(/Edited review feedback/);
  await page.evaluate(() => { (window as any).__demo.stale = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.dv-stale')).toContainText('Stale anchor');
  await page.locator('.dv-feedback > summary').click();
  await expect(page.getByRole('textbox', { name: 'Select and copy feedback' })).not.toHaveValue(/Edited review feedback/);
  await expect(page.getByRole('button', { name: 'Insert feedback into draft' })).toHaveCount(0);
  await page.locator('.dv-comment').getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.locator('.dv-comment')).toHaveCount(0);
});

test('explicit target confirmation cancels without request; conflict never retries', async ({ page }) => {
  await ready(page, '?scenario=conflict');
  await page.locator('.dv-file-heading').getByRole('button', { name: 'Revert', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('src/review/index.ts');
  await expect(dialog).toContainText('Entire file');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await calls(page, 'diff.action')).length).toBe(0);
  await page.locator('.dv-hunk-heading').first().getByRole('button', { name: 'Stage', exact: true }).click();
  await expect(dialog).toContainText('Hunk @@ -1,3 +1,4 @@');
  await dialog.getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('FILE_CONFLICT');
  const sent = await calls(page, 'diff.action'); expect(sent).toHaveLength(1); expect(sent[0].args).toMatchObject({ confirmed: true, fileId: 'review', hunkId: '0:1:1', fingerprint: 'version-review' });
});

test('successful operation refreshes; native patch copy and clear history use backend', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Copy diff' }).click();
  await expect(page.getByRole('status')).toContainText('Diff copied');
  expect((await calls(page, 'diff.copyPatch'))[0].args.fileId).toBe('review');
  await page.locator('.dv-file-heading').getByRole('button', { name: 'Stage', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.locator('.dv-message[role="status"]')).toContainText('Demo operation completed');
  await expect.poll(async () => (await calls(page, 'diff.review')).length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Clear recorded history' }).click();
  await expect(page.getByRole('dialog')).toContainText('Git changes are not affected');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.locator('.dv-message[role="status"]')).toContainText('Recorded history cleared');
  expect((await calls(page, 'diff.clearHistory'))[0].args.confirmed).toBe(true);
});

test('keyboard focus, collapse and bounded long-diff pagination', async ({ page }) => {
  await ready(page);
  await page.locator('.dv-diff-pane').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('[data-hunk-nav]').first()).toBeFocused();
  expect(await page.locator('[data-hunk-nav]').first().evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('[data-hunk-nav]').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-hunk-nav]').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('searchbox').fill('long.ts'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await expect(page.locator('.dv-pagination')).toContainText('1–80 of 2000');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.dv-pagination')).toContainText('81–160 of 2000');
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await expect(page.getByRole('button', { name: 'Add comment: New 41', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.dv-pagination')).toContainText('1–80 of 2000');
  expect((await calls(page, 'diff.file')).every((call: any) => call.args.limit === 80)).toBe(true);
});

test('errors recover; empty scopes and special nontext statuses have no operations', async ({ page }) => {
  await page.goto('/?scenario=file-error');
  await expect(page.getByRole('alert')).toContainText('Demo file request failed');
  await page.getByRole('button', { name: 'Retry' }).click(); await expect(page.locator('.dv-hunk')).toHaveCount(2);
  for (const [path, phrase] of [['assets/logo.png', 'Binary file'], ['src/historical.ts', 'Historical content is missing'], ['special/large', 'text diff limit'], ['special/symlink', 'Symbolic link'], ['special/submodule', 'Submodule change'], ['special/conflict', 'Unresolved merge conflict']]) {
    await page.getByRole('searchbox').fill(path); await page.locator('.dv-file').click();
    await expect(page.locator('.dv-diff-pane')).toContainText(phrase);
    await expect(page.locator('.dv-file-heading').getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
  }
  await page.getByRole('combobox', { name: 'Scope' }).selectOption('staged');
  await expect(page.locator('main')).toContainText('No changes in this scope.');
});

for (const width of [360, 760, 1280]) test(`responsive ${width}px; Chinese/dark, reduced motion and chrome offsets`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page, '?lang=zh-CN&base=dark');
  await expect(page.getByRole('heading', { name: '审阅更改', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  expect(await page.locator('.dv-hunk').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, app: document.querySelector('.dv-app')!.getBoundingClientRect().toJSON(), main: document.querySelector('main')!.getBoundingClientRect().toJSON() }));
  expect(bounds.scroll).toBeLessThanOrEqual(width); expect(bounds.app.top).toBe(0); expect(bounds.app.height).toBe(900); expect(bounds.main.width).toBeGreaterThan(0);
  await page.getByRole('combobox', { name: '语言' }).selectOption('en'); await expect(page.getByRole('heading', { name: 'Review changes' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('light'); await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'light');
  await page.evaluate(() => { document.documentElement.style.setProperty('--pi-plugin-titlebar-height', '46px'); });
  expect(await page.locator('.dv-app').evaluate(node => node.getBoundingClientRect().top)).toBe(0);
  expect(await page.locator('.dv-app').evaluate(node => node.getBoundingClientRect().height)).toBe(854);
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
});

test('appearance events update both language/theme; bridge calls stay below ten/sec', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__demo.changeAppearance({ locale: 'zh-CN', base: 'dark' }));
  await expect(page.getByRole('heading', { name: '审阅更改', exact: true })).toBeVisible();
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  const logs = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method.startsWith('diff.') && !call.internal));
  for (let i = 1; i < logs.length; i++) expect(logs[i].at - logs[i - 1].at).toBeGreaterThanOrEqual(140);
});

test('recorded turns have file-only restore operations; reference scopes are read-only', async ({ page }) => {
  await ready(page);
  await page.getByRole('combobox', { name: 'Scope' }).selectOption('turn');
  await expect(page.getByRole('combobox', { name: 'Turn', exact: true })).toBeVisible();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-hunk-heading').getByRole('button', { name: 'Revert', exact: true })).toHaveCount(0);
  await expect(page.locator('.dv-file-heading').getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Scope' }).selectOption('commit');
  await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('HEAD~1');
  await page.getByRole('button', { name: 'Review reference' }).click();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-file-heading').getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
});

test('bootstrap error/no-root states are honest; scope changes discard slow responses', async ({ page }) => {
  await page.goto('/?scenario=boot-error');
  await expect(page.getByRole('alert')).toContainText('Demo bridge denied access');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.goto('/?scenario=no-roots');
  await expect(page.locator('main')).toContainText('No repository or recorded turn is available');
  await page.goto('/?scenario=slow');
  await expect(page.getByRole('combobox', { name: 'Scope' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Scope' }).selectOption('commit');
  await expect(page.locator('main')).toContainText('Enter a commit or branch reference');
  await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('HEAD');
  await page.getByRole('button', { name: 'Review reference' }).click();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-file-heading').getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
});

test('background reviews exceeding two seconds use short polling and never retry mutations', async ({ page }) => {
  await ready(page, '?scenario=long-job');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await calls(page, 'diff.jobPoll')).length).toBeGreaterThan(4);
  const starts = await calls(page, 'diff.jobStart');
  expect(starts.filter((call: any) => call.args.method === 'review')).toHaveLength(1);
});

test('batch confirmation lists exact files and displays individual success/conflict results', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Revert · 4', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('src/review/index.ts'); await expect(dialog).toContainText('src/theme/index.ts');
  await expect(dialog).toContainText('not an atomic transaction'); await dialog.getByRole('button', { name: 'Confirm operation' }).click();
  await expect(page.locator('details.dv-message')).toContainText('✓ src/review/index.ts'); await expect(page.locator('details.dv-message')).toContainText('✗ src/theme/index.ts: Demo FILE_CONFLICT');
  expect((await calls(page, 'diff.batchAction'))).toHaveLength(1);
});
