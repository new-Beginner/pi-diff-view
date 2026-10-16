import { test, expect, type Page } from '@playwright/test';
import { selectScope } from './scope-helpers';
// Generic diff/Git component coverage is isolated from production Panel identity rules.
const ready = async (page: Page, query = '') => { await page.goto(`/review-component/${query}`); await expect(page.locator('.dv-hunk')).toHaveCount(2); };
const calls = async (page: Page, method: string) => page.evaluate(method => (window as any).__demo.calls.filter((call: any) => call.method === method), method);
const settings = async (page: Page) => { if (!await page.locator('.dv-top .dv-menu').evaluate(node => (node as HTMLDetailsElement).open)) await page.locator('.dv-top .dv-menu > summary').click(); };
const fileMenu = (page: Page) => page.locator('.dv-file-row:has(.dv-file[aria-current="true"]) .dv-file-menu');
const fileActions = async (page: Page) => { if (!await fileMenu(page).evaluate(node => (node as HTMLDetailsElement).open)) await fileMenu(page).locator('summary').click(); };
const search = async (page: Page) => { if (!await page.getByRole('searchbox').isVisible()) await page.locator('.dv-top .dv-icon-button').first().click(); };

test('file paths disambiguate; newly created file has only new line numbers', async ({ page }) => {
  await ready(page);
  await settings(page); await expect(page.getByText('Demo data · mocked backend / 演示数据 · 模拟后端')).toBeVisible();
  await search(page); await page.getByRole('searchbox').fill('src/theme');
  await expect(page.locator('.dv-file')).toHaveCount(1);
  await page.locator('.dv-file').click();
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts');
  await expect(page.locator('.dv-row')).toHaveCount(3);
  await expect(page.locator('.dv-number[data-side="old"]')).toHaveCount(0);
  await expect(page.locator('.dv-row .dv-number').first()).toHaveText('1');
  await page.getByRole('searchbox').fill('nothing-matches');
  await expect(page.getByText('No matching paths.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.dv-file')).toHaveCount(10);
});

test('split rows align; syntax and changed words survive wrap; context disables hunk actions', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.hljs-keyword').first()).toBeVisible();
  await expect(page.locator('mark.dv-word').first()).toBeVisible();
  await settings(page);
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
  await expect(page.locator('.dv-pagination')).toHaveCount(0);
  expect((await calls(page, 'diff.file')).at(-1).args.context).toBe(-1);
});

test('single-column gutters and clean sidebar omit commentary and pagination chrome', async ({ page }) => {
  await page.setViewportSize({ width: 550, height: 900 }); await ready(page);
  await expect(page.locator('.dv-file-heading, .dv-notice, .dv-pagination, .dv-comments, .dv-feedback, button.dv-number')).toHaveCount(0);
  expect(await page.locator('.dv-row').evaluateAll(rows => rows.every(row => row.querySelectorAll('.dv-number').length === 1))).toBe(true);
  const deleted = page.locator('.dv-del .dv-number').first(), added = page.locator('.dv-add .dv-number').first();
  await expect(deleted).toHaveText('2'); await expect(deleted).toHaveAttribute('data-side', 'old');
  await expect(added).toHaveText('2'); await expect(added).toHaveAttribute('data-side', 'new');
  expect((await calls(page, 'diff.comments')).length).toBe(0); expect((await calls(page, 'diff.feedback')).length).toBe(0);
  const bounds = await page.locator('.dv-file-row').first().evaluate(node => ({ fileBottom: node.getBoundingClientRect().bottom, diffTop: document.querySelector('.dv-diff-pane')!.getBoundingClientRect().top }));
  expect(Math.abs(bounds.fileBottom - bounds.diffTop)).toBeLessThanOrEqual(1);
  await fileActions(page); await expect(fileMenu(page).getByRole('button', { name: 'Copy diff' })).toBeVisible();
});

test('explicit target confirmation cancels without request; conflict never retries', async ({ page }) => {
  await ready(page, '?scenario=conflict');
  await fileActions(page);
  await fileMenu(page).getByRole('button', { name: 'Revert', exact: true }).click();
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

test('successful operation refreshes; mocked patch copy and clear history use backend', async ({ page }) => {
  await ready(page);
  await fileActions(page);
  await page.getByRole('button', { name: 'Copy diff' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Diff copied' })).toHaveText('Diff copied');
  expect((await calls(page, 'diff.copyPatch'))[0].args.fileId).toBe('review');
  await fileActions(page);
  await fileMenu(page).getByRole('button', { name: 'Stage', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Demo operation completed' })).toHaveText('Demo operation completed');
  await expect.poll(async () => (await calls(page, 'diff.review')).length).toBeGreaterThan(1);
  await settings(page);
  await page.getByRole('button', { name: 'Clear recorded history' }).click();
  await expect(page.getByRole('dialog')).toContainText('Git changes are not affected');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Recorded history cleared' })).toHaveText('Recorded history cleared');
  expect((await calls(page, 'diff.clearHistory'))[0].args.confirmed).toBe(true);
});

test('keyboard focus, collapse and long-diff automatic continuation retain earlier rows', async ({ page }) => {
  await ready(page);
  await page.locator('.dv-diff-pane').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('[data-hunk-nav]').first()).toBeFocused();
  expect(await page.locator('[data-hunk-nav]').first().evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('[data-hunk-nav]').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-hunk-nav]').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await search(page); await page.getByRole('searchbox').fill('long.ts'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await expect(page.locator('.dv-pagination')).toHaveCount(0);
  const first = await page.locator('.dv-row').first().textContent();
  await page.locator('.dv-continuation').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('.dv-row').count()).toBeGreaterThanOrEqual(160);
  await expect(page.locator('.dv-row').first()).toHaveText(first!);
  await expect(page.locator('.dv-number[data-side="new"]').filter({ hasText: /^41$/ })).toHaveCount(1);
  await page.locator('.dv-workspace').evaluate(node => node.scrollTop = 0);
  expect((await calls(page, 'diff.file')).every((call: any) => call.args.limit === 80)).toBe(true);
  const offsets = (await calls(page, 'diff.file')).filter((call: any) => call.args.fileId === 'long').map((call: any) => call.args.offset);
  expect(offsets.slice(0, 2)).toEqual([0, 80]); expect(new Set(offsets).size).toBe(offsets.length);
  await page.getByRole('searchbox').fill('src/theme'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(3); await expect(page.locator('.dv-continuation')).toHaveCount(0);
});

test('errors recover; empty scopes and special nontext statuses have no operations', async ({ page }) => {
  await page.goto('/review-component/?scenario=file-error');
  await expect(page.getByRole('alert')).toContainText('Demo file request failed');
  await page.getByRole('button', { name: 'Retry' }).click(); await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await search(page);
  for (const [path, phrase] of [['assets/data.bin', 'Binary file'], ['src/historical.ts', 'Historical content is missing'], ['special/large', 'text diff limit'], ['special/symlink', 'Symbolic link'], ['special/submodule', 'Submodule change'], ['special/conflict', 'Unresolved merge conflict']]) {
    await page.getByRole('searchbox').fill(path); await page.locator('.dv-file').click();
    await expect(page.locator('.dv-diff-pane')).toContainText(phrase);
    await expect(fileMenu(page).getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
  }
  await selectScope(page.getByRole('combobox', { name: 'Scope' }), 'staged');
  await page.getByRole('searchbox').fill('');
  await expect(page.locator('.dv-rail-empty')).toHaveText('No changes in this scope.');
  await expect(page.locator('.dv-rail-empty')).toBeVisible();
});

for (const width of [360, 760, 1280]) test(`responsive ${width}px; Chinese/dark, reduced motion and chrome offsets`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page, '?lang=zh-CN&base=dark');
  await expect(page.locator('.dv-app')).toHaveAttribute('lang', 'zh-CN'); await settings(page);
  await page.getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  expect(await page.locator('.dv-hunk').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, app: document.querySelector('.dv-app')!.getBoundingClientRect().toJSON(), main: document.querySelector('main')!.getBoundingClientRect().toJSON() }));
  expect(bounds.scroll).toBeLessThanOrEqual(width); expect(bounds.app.top).toBe(0); expect(bounds.app.height).toBe(900); expect(bounds.main.width).toBeGreaterThan(0);
  await settings(page); await page.getByRole('combobox', { name: '语言' }).selectOption('en'); await expect(page.locator('.dv-app')).toHaveAttribute('lang', 'en');
  await page.evaluate(() => (window as any).__demo.changeAppearance({ locale: 'en', base: 'light' })); await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'light');
  await page.evaluate(() => { document.documentElement.style.setProperty('--pi-plugin-titlebar-height', '46px'); });
  expect(await page.locator('.dv-app').evaluate(node => node.getBoundingClientRect().top)).toBe(0);
  expect(await page.locator('.dv-app').evaluate(node => node.getBoundingClientRect().height)).toBe(854);
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
});

test('appearance events update both language/theme; bridge calls stay below ten/sec', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__demo.changeAppearance({ locale: 'zh-CN', base: 'dark' }));
  await expect(page.locator('.dv-app')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  const logs = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method.startsWith('diff.') && !call.internal));
  for (const call of logs) expect(logs.filter((other: any) => other.at >= call.at && other.at < call.at + 1000).length).toBeLessThanOrEqual(6);
});

test('recorded turns have file-only restore operations; reference scopes are read-only', async ({ page }) => {
  await ready(page);
  await selectScope(page.getByRole('combobox', { name: 'Scope' }), 'turn');
  await settings(page);
  await expect(page.getByRole('combobox', { name: '对话轮次', exact: true })).toBeVisible();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dv-hunk-heading').getByRole('button', { name: 'Revert', exact: true })).toHaveCount(0);
  await fileActions(page);
  await expect(fileMenu(page).getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await selectScope(page.getByRole('combobox', { name: 'Scope' }), 'commit');
  await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('HEAD~1');
  await page.getByRole('button', { name: 'Review reference' }).click();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(fileMenu(page).getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
});

test('bootstrap error/no-root states are honest; scope changes discard slow responses', async ({ page }) => {
  await page.goto('/review-component/?scenario=boot-error');
  await expect(page.getByRole('alert')).toContainText('Demo bridge denied access');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.goto('/review-component/?scenario=no-roots');
  await expect(page.locator('main')).toContainText('No repository or recorded turn is available');
  await page.goto('/review-component/?scenario=slow');
  await expect(page.getByRole('combobox', { name: 'Scope' })).toBeEnabled();
  await selectScope(page.getByRole('combobox', { name: 'Scope' }), 'commit');
  await expect(page.locator('main')).toContainText('Enter a commit or branch reference');
  await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('HEAD');
  await page.getByRole('button', { name: 'Review reference' }).click();
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(fileMenu(page).getByRole('button', { name: /Stage|Revert/ })).toHaveCount(0);
});

test('background reviews exceeding two seconds use short polling and never retry mutations', async ({ page }) => {
  await ready(page, '?scenario=long-job');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await calls(page, 'diff.jobPoll')).length).toBeGreaterThan(4);
  const starts = await calls(page, 'diff.jobStart');
  expect(starts.filter((call: any) => call.args.method === 'review')).toHaveLength(1);
});

test('batch confirmation lists exact files and displays individual success/conflict results', async ({ page }) => {
  await ready(page); await settings(page); await page.getByRole('button', { name: 'Revert · 4', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('src/review/index.ts'); await expect(dialog).toContainText('src/theme/index.ts');
  await expect(dialog).toContainText('not an atomic transaction'); await dialog.getByRole('button', { name: 'Confirm operation' }).click();
  await expect(page.locator('details.dv-message')).toContainText('✓ src/review/index.ts'); await expect(page.locator('details.dv-message')).toContainText('✗ src/theme/index.ts: Demo FILE_CONFLICT');
  expect((await calls(page, 'diff.batchAction'))).toHaveLength(1);
});

test('compact accordion and menus follow live host tokens without remounting', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 }); await ready(page);
  await expect(page.locator('.dv-files, .dv-display-toolbar')).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.locator('.dv-top')).toHaveCSS('height', '53px');
  const row = page.locator('.dv-file[aria-current="true"]');
  await row.click(); await expect(page.locator('.dv-review')).toBeHidden();
  await row.click(); await expect(page.locator('.dv-review')).toBeVisible();
  await settings(page); await expect(page.getByRole('checkbox', { name: 'Wrap lines' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.dv-top .dv-menu')).not.toHaveAttribute('open', '');
  for (const [bg, ink, expectedBg, expectedInk] of [['#efe3df', '#342824', 'rgb(239, 227, 223)', 'rgb(52, 40, 36)'], ['#132a24', '#e8f8ee', 'rgb(19, 42, 36)', 'rgb(232, 248, 238)']]) {
    await page.evaluate(([bg, ink]) => { document.documentElement.style.setProperty('--ds-bg-dock', bg); document.documentElement.style.setProperty('--ds-text-primary', ink); }, [bg, ink]);
    await expect(page.locator('.dv-app')).toHaveCSS('background-color', expectedBg); await expect(page.locator('.dv-app')).toHaveCSS('color', expectedInk);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await page.evaluate(() => (window as any).__demo.changeAppearance({ locale: 'en', base: 'dark' }));
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  await expect(page.locator('.dv-app')).toHaveCSS('background-color', 'rgb(19, 42, 36)');
});

test('automatic continuation reaches the last row without duplicates or pagination buttons', async ({ page }) => {
  await ready(page); await search(page); await page.getByRole('searchbox').fill('long.ts'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(80);
  for (let count = 80; count < 2000; count += 80) {
    await page.locator('.dv-continuation').scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator('.dv-row').count()).toBeGreaterThanOrEqual(Math.min(2000, count + 80));
  }
  await expect(page.locator('.dv-row')).toHaveCount(2000); await expect(page.locator('.dv-hunk')).toHaveCount(1);
  await expect(page.locator('.dv-continuation, .dv-pagination')).toHaveCount(0);
  await expect(page.locator('.dv-number').last()).toHaveText('1000');
  const offsets = (await calls(page, 'diff.file')).filter((call: any) => call.args.fileId === 'long').map((call: any) => call.args.offset);
  expect(offsets).toEqual(Array.from({ length: 25 }, (_, i) => i * 80));
});

test('a failed continuation retains the diff and retries only after an explicit click', async ({ page }) => {
  await ready(page); await search(page); await page.getByRole('searchbox').fill('long.ts'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await page.evaluate(() => {
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge); let failed = false;
    bridge.invoke = async (method: string, args: any, internal: boolean) => { if (method === 'diff.file' && args.offset === 80 && !failed) { failed = true; throw new Error('Demo continuation failed'); } return invoke(method, args, internal); };
  });
  await page.locator('.dv-continuation').scrollIntoViewIfNeeded(); await expect(page.getByRole('alert')).toContainText('Demo continuation failed');
  await expect(page.locator('.dv-row')).toHaveCount(80); await page.waitForTimeout(400); await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect.poll(() => page.locator('.dv-row').count()).toBeGreaterThanOrEqual(160);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('switching files during continuation ignores the old page', async ({ page }) => {
  await ready(page); await search(page); await page.getByRole('searchbox').fill('long.ts'); await page.locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await page.evaluate(() => {
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (method: string, args: any, internal: boolean) => { const result = await invoke(method, args, internal); if (method === 'diff.file' && args.offset === 80) { (window as any).__moreWaiting = true; await new Promise<void>(resolve => (window as any).__finishMore = resolve); } return result; };
  });
  await page.locator('.dv-continuation').scrollIntoViewIfNeeded(); await expect.poll(() => page.evaluate(() => (window as any).__moreWaiting)).toBe(true);
  await page.getByRole('searchbox').fill('src/theme'); await page.locator('.dv-file').click(); await expect(page.locator('.dv-row')).toHaveCount(3);
  await page.evaluate(() => (window as any).__finishMore()); await page.waitForTimeout(300);
  await expect(page.locator('.dv-row')).toHaveCount(3); await expect(page.locator('.dv-review h2')).toHaveText('src/theme/index.ts'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a new target during the first review wins even before bootstrap completes', async ({ page }) => {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set: value => {
      bridge = value;
      const demo = (window as any).__demo, nonce = '00000000-0000-4000-8000-000000000123';
      demo.navigation.set(nonce, { nonce, revision: 1, sessionId: 'session-demo', request: { scope: 'turn', root: 'D:/projects/diff-view', sessionId: 'session-demo', runId: 'run-demo' }, fileId: 'review' });
      const invoke = bridge.invoke.bind(bridge); let first = true;
      bridge.invoke = async (method: string, args: any, internal: boolean) => {
        if (method === 'diff.review' && internal && first) {
          first = false; const result = await invoke(method, args, internal);
          (window as any).__firstReviewWaiting = true;
          await new Promise<void>(resolve => (window as any).__finishFirstReview = resolve);
          return { ...result, files: result.files.filter((file: any) => file.id === 'review') };
        }
        if (method === 'diff.bootstrap' && internal) {
          const result = await invoke(method, args, internal);
          await new Promise<void>(resolve => (window as any).__finishBootstrap = resolve);
          return result;
        }
        return invoke(method, args, internal);
      };
    } });
  });
  await page.goto('/?scenario=renderer&piViewOpen=' + encodeURIComponent('diff-view:00000000-0000-4000-8000-000000000123?sessionId=session-demo'));
  await expect.poll(() => page.evaluate(() => (window as any).__firstReviewWaiting)).toBe(true);
  await page.evaluate(() => {
    const demo = (window as any).__demo, nonce = '00000000-0000-4000-8000-000000000123';
    demo.navigation.set(nonce, { ...demo.navigation.get(nonce), revision: 2, fileId: 'created' });
    demo.openLocation(`diff-view:${nonce}?sessionId=session-demo`);
  });
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts');
  await expect(page.locator('.dv-row')).toHaveCount(3);
  await page.evaluate(() => { (window as any).__finishFirstReview(); (window as any).__finishBootstrap?.(); });
  await page.waitForTimeout(400);
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts');
  const reviews = await calls(page, 'diff.review'); expect(reviews).toHaveLength(2); expect(reviews[1].args.focusFileId).toBe('created');
});

test('every file has reference-style controls and menus act on their own file', async ({ page }) => {
  await page.setViewportSize({ width: 590, height: 700 }); await ready(page, '?lang=zh-CN');
  await expect(page.locator('.dv-review-pill .dv-counts')).toBeVisible();
  await expect(page.locator('.dv-file-menu')).toHaveCount(10);
  await expect(page.locator('.dv-file-open')).toHaveCount(10);
  await expect(page.locator('.dv-file-type svg')).toHaveCount(10);
  const created = page.locator('.dv-file-row').filter({ has: page.locator('.dv-file-name', { hasText: 'src/theme/index.ts' }) });
  await created.locator('summary').click();
  await created.getByRole('button', { name: '复制路径', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('路径已复制');
  expect((await calls(page, 'diff.copyPath')).at(-1).args.fileId).toBe('created');
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/review/index.ts');
  await created.locator('summary').click();
  await created.getByRole('button', { name: '复制差异', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('差异已复制');
  expect((await calls(page, 'diff.copyPatch')).at(-1).args.fileId).toBe('created');
  await page.keyboard.press('Escape');
  await created.locator('.dv-file').click();
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts');
  await expect(page.locator('.dv-row')).toHaveCount(3);
  await page.getByRole('button', { name: '折叠文件', exact: true }).click();
  await expect(page.locator('.dv-review')).toBeHidden();
  await created.locator('summary').click();
  await created.getByRole('button', { name: '展开文件', exact: true }).click();
  await expect(page.locator('.dv-review')).toBeVisible();
  await expect(created.locator('.dv-file-menu')).not.toHaveAttribute('open');
});

test('legacy image entries are excluded before selection and totals; text and binary data remain', async ({ page }) => {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set: value => {
      bridge = value; const invoke = bridge.invoke.bind(bridge);
      bridge.invoke = async (method: string, args: any, internal: boolean) => {
        const result = await invoke(method, args, internal);
        if (method === 'diff.review') return { ...result, files: [
          ...['preview.PNG', 'logo.svg', 'photo.JPEG'].map((path, i) => ({ ...result.files[0], id: `image-${i}`, path, additions: 9000 })),
          ...result.files,
        ] };
        return result;
      };
    } });
  });
  await ready(page);
  await expect(page.locator('.dv-file')).toHaveCount(10);
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('src/review/index.ts');
  await expect(page.locator('.dv-file-name').filter({ hasText: /preview.PNG|logo.svg|photo.JPEG/ })).toHaveCount(0);
  await expect(page.locator('.dv-file-name').filter({ hasText: 'assets/data.bin' })).toHaveCount(1);
  await expect(page.locator('.dv-review-pill .dv-added')).toHaveText('+1009');
});

test('last-row menu flips upward and stays inside the scroll viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 430 }); await ready(page);
  await page.getByRole('button', { name: 'Collapse file', exact: true }).click();
  const last = page.locator('.dv-file-row').last();
  await last.locator('summary').click();
  await expect(last.locator('.dv-file-menu')).toHaveAttribute('data-placement', 'above');
  const bounds = await last.locator('.dv-menu-body').evaluate(node => ({ menu: node.getBoundingClientRect().toJSON(), viewport: document.querySelector('.dv-workspace')!.getBoundingClientRect().toJSON() }));
  expect(bounds.menu.bottom).toBeLessThanOrEqual(bounds.viewport.bottom);
  expect(bounds.menu.top).toBeGreaterThanOrEqual(bounds.viewport.top);
  await page.keyboard.press('Escape'); await expect(last.locator('.dv-file-menu')).not.toHaveAttribute('open');
});

for (const base of ['light', 'dark']) test(`file rows stay transparent and arrows appear only on hover (${base})`, async ({ page }) => {
  await page.setViewportSize({ width: 590, height: 800 }); await ready(page, `?base=${base}`);
  const row = page.locator('.dv-file-row').first(), file = row.locator('.dv-file'), arrow = row.locator('.dv-file-chevron');
  const transparent = async () => {
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(file).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(file).toHaveCSS('box-shadow', 'none');
  };
  await page.mouse.move(0, 0); await expect(arrow).toHaveCSS('opacity', '0'); await transparent();
  await file.hover(); await expect(arrow).toHaveCSS('opacity', '1'); await expect(arrow).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)'); await transparent();
  await page.mouse.down(); await transparent(); await page.mouse.up();
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  await expect(arrow).toHaveCSS('transform', 'none'); await expect(arrow).toHaveCSS('opacity', '1'); await transparent();
  await page.mouse.move(0, 0); await file.focus(); await expect(arrow).toHaveCSS('opacity', '0'); await transparent();
  await row.locator('.dv-file-open').hover(); await expect(arrow).toHaveCSS('opacity', '1');
  await file.click(); await page.mouse.move(0, 0);
  await expect(file).toHaveAttribute('aria-expanded', 'true'); await expect(arrow).toHaveCSS('opacity', '0'); await transparent();
  await file.hover(); await expect(arrow).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
});

test('file open icon uses the default app without expanding or selecting the diff', async ({ page }) => {
  await ready(page, '?session=session-demo&lang=zh-CN');
  const current = page.locator('.dv-file[aria-current="true"]');
  await current.click(); await expect(current).toHaveAttribute('aria-expanded', 'false');
  const row = page.locator('.dv-file-row').filter({ has: page.locator('.dv-file', { hasText: 'src/theme/index.ts' }) });
  const button = row.locator('.dv-file-open');
  await expect(button).toHaveAttribute('title', '使用系统默认程序打开当前磁盘文件');
  await button.click(); await expect(button).toBeEnabled();
  const sent = await calls(page, 'diff.openSystemFile');
  expect(sent[0].args).toEqual({ reviewId: expect.any(String), fileId: 'created', sessionId: 'session-demo' });
  expect(await page.evaluate(() => (window as any).__demo.systemOpenedFile)).toBe('src/theme/index.ts');
  expect(await calls(page, 'diff.openFile')).toHaveLength(0);
  await expect(current).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.dv-review')).toBeHidden();
  await row.locator('.dv-file-menu > summary').click();
  await expect(row.getByRole('button', { name: '外部打开', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: '展开文件', exact: true }).click();
  await expect(row.locator('.dv-file')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.dv-row')).toHaveCount(3);
});

test('default-app failure is visible without retrying or expanding the diff', async ({ page }) => {
  await ready(page, '?session=session-demo&lang=zh-CN');
  const current = page.locator('.dv-file[aria-current="true"]');
  await current.click();
  await page.evaluate(() => { (window as any).__demo.systemOpenError = '没有可用的默认应用'; });
  const button = page.locator('.dv-file-open').first();
  await button.click();
  await expect(page.getByRole('alert')).toContainText('没有可用的默认应用');
  await expect(button).toBeEnabled();
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(1);
  expect(await calls(page, 'diff.openFile')).toHaveLength(0);
  await expect(current).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.dv-review')).toBeHidden();
});

test('file open icon sends identities once and removes the duplicate external-open menu', async ({ page }) => {
  await ready(page, '?session=session-demo&lang=zh-CN');
  await page.evaluate(() => { (window as any).__demo.deferSystemOpen = true; });
  const open = page.locator('.dv-file-row:has(.dv-file[aria-current="true"]) .dv-file-open');
  await open.click();
  await expect.poll(async () => (await calls(page, 'diff.openSystemFile')).length).toBe(1);
  const sent = (await calls(page, 'diff.openSystemFile'))[0].args;
  expect(sent).toEqual({ reviewId: expect.any(String), fileId: 'review', sessionId: 'session-demo' });
  await expect(page.locator('.dv-file-open:enabled')).toHaveCount(0);
  await open.evaluate(node => (node as HTMLButtonElement).click());
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__demo.finishSystemOpen)).toBe('function');
  await page.evaluate(() => (window as any).__demo.finishSystemOpen());
  await expect(page.getByRole('status').filter({ hasText: '已向系统提交打开请求' })).toBeVisible();
  await expect(open).toBeEnabled();
  await fileActions(page);
  await expect(fileMenu(page).getByRole('button', { name: /外部打开|Open with default app/ })).toHaveCount(0);
  expect(await calls(page, 'diff.openFile')).toHaveLength(0);
});

test('system-open executable confirmation cancels without launch and confirms one launch', async ({ page }) => {
  await ready(page, '?session=session-demo&scenario=system-executable');
  const open = page.locator('.dv-file-row:has(.dv-file[aria-current="true"]) .dv-file-open');
  await expect(open).toHaveAttribute('title', 'Open the current disk file with its default app');
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm system open' });
  await expect(dialog).toContainText('may execute a program or script');
  await expect(dialog).toContainText('scripts/run.CMD');
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(0);
  await open.click();
  await dialog.getByRole('button', { name: 'Confirm operation', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'diff.openSystemFile')).length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Open request submitted to the system' })).toBeVisible();
});

test('system-open allows binary/unavailable diffs and displays failure without retrying', async ({ page }) => {
  await ready(page, '?session=session-demo&lang=zh-CN');
  const binary = page.locator('.dv-file-row').filter({ has: page.locator('.dv-file', { hasText: 'assets/data.bin' }) });
  await binary.locator('.dv-file-open').click();
  await expect.poll(async () => (await calls(page, 'diff.openSystemFile')).length).toBe(1);
  expect((await calls(page, 'diff.openSystemFile'))[0].args.fileId).toBe('binary');
  await expect(page.getByRole('status').filter({ hasText: '已向系统提交打开请求' })).toBeVisible();
  await page.evaluate(() => { (window as any).__demo.systemOpenError = '文件已不存在，无法系统打开。'; });
  const missing = page.locator('.dv-file-row').filter({ has: page.locator('.dv-file', { hasText: 'src/historical.ts' }) });
  await missing.locator('.dv-file-open').click();
  await expect(page.getByRole('alert')).toContainText('文件已不存在，无法系统打开');
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(2);
  expect((await calls(page, 'diff.openSystemFile'))[1].args.fileId).toBe('missing');
});

test('file open icon is disabled without an explicit review session', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.dv-file-open:enabled')).toHaveCount(0);
  await fileActions(page);
  await expect(fileMenu(page).getByRole('button', { name: 'Open with default app', exact: true })).toHaveCount(0);
  expect(await calls(page, 'diff.openSystemFile')).toHaveLength(0);
});
