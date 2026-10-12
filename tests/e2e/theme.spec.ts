import { test, expect, type Page, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

// Actual source Panel + isolated mock bridge. No generated plugin assets, server changes, or real Git writes.
let assets: Record<string, string>;
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { const errors: string[] = []; runtimeErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['src/view/index.tsx'], bundle: true, write: false, outfile: 'index.js', platform: 'browser', format: 'esm', target: 'es2022', define: { 'process.env.NODE_ENV': '"test"' } });
  assets = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/index.css' : '/index.js', file.text]));
  assets['/mock.js'] = await fs.readFile('tests/e2e/mock.js', 'utf8') + '\n' + await fs.readFile('tests/e2e/theme-mock.js', 'utf8');
  assets['/'] = (await fs.readFile('src/view/index.html', 'utf8')).replace('<title>', '<title>演示数据 · 模拟桥接 · ').replace('<body>', '<body><script src="/mock.js"></script>');
});
async function open(page: Page, params = '') {
  await page.route('http://theme-fixture.invalid/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ status: assets[pathname] ? 200 : 404, contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html', body: assets[pathname] ?? '' });
  });
  await page.goto('http://theme-fixture.invalid/?lang=zh-CN&scenario=panel&' + params);
  await expect(page.locator('.dv-panel')).toBeVisible();
}
async function noHorizontalOverflow(page: Page) {
  const defects = await page.evaluate(() => {
    const issues: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`document ${document.documentElement.scrollWidth}/${innerWidth}`);
    for (const element of document.querySelectorAll<HTMLElement>('.dv-panel-content, .dv-app, .dv-top, .git-management, .gm-controls, .gm-list, .gm-dialog')) {
      if (element.getClientRects().length && element.scrollWidth > element.clientWidth + 1) issues.push(`${element.className} ${element.scrollWidth}/${element.clientWidth}`);
    }
    for (const element of document.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, .dv-file-name, .gm-path')) {
      if (!element.getClientRects().length || element.closest('[hidden]')) continue;
      const bounds = element.getBoundingClientRect();
      if (bounds.width && (bounds.left < -1 || bounds.right > innerWidth + 1)) issues.push(`${element.tagName} ${element.textContent?.slice(0, 30)} bounds ${bounds.left}/${bounds.right}`);
    }
    return issues;
  });
  expect(defects).toEqual([]);
}
async function focusVisible(control: Locator) {
  await expect(control).toBeFocused();
  const outline = await control.evaluate(element => {
    const style = getComputedStyle(element);
    return { visible: element.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline).toEqual({ visible: true, width: '2px', style: 'solid' });
}
async function screenshot(page: Page, name: string) {
  if (!process.env.THEME_SCREENSHOTS) return;
  await fs.mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: path.join('docs/screenshots', `theme-${name}.png`), animations: 'disabled' });
}
const session = 'piViewOpen=' + encodeURIComponent('diff-session:session-a?sessionId=session-a');
const background = { light: 'rgb(250, 250, 250)', dark: 'rgb(33, 33, 33)' };
for (const width of [360, 600, 1100]) for (const base of ['light', 'dark'] as const) {
  test(`fallback ${base} at ${width}: Git, session, modal, focus and layout`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, `base=${base}&${session}`);
    await expect(page.locator('.dv-app')).toHaveAttribute('data-base', base);
    await expect(page.locator('.dv-file').first()).toBeVisible();
    await expect(page.locator('.dv-hunk').first()).toBeVisible();
    await expect(page.locator('.dv-file-name').first()).toContainText('very-long-directory-name');
    await expect(page.locator('.dv-app')).toHaveCSS('background-color', background[base]);
    await expect(page.locator('.dv-file[aria-current=true]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await noHorizontalOverflow(page);
    await screenshot(page, `session-${width}-${base}`);
    await page.getByRole('button', { name: '本地 Git', exact: true }).click();
    const git = page.locator('.git-management');
    await expect(git).toHaveCSS('background-color', background[base]);
    await expect(git.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(git.locator('input[type="checkbox"]')).toHaveCount(6);
    await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
    await expect(page.locator('.gm-selected')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '暂存所选 (2)', exact: true })).toBeEnabled();
    await noHorizontalOverflow(page);
    await screenshot(page, `git-${width}-${base}`);
    const protectedGroup = page.locator('.gm-protected');
    await expect(protectedGroup).not.toHaveAttribute('open');
    expect(await protectedGroup.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[aria-label="可操作文件"]')!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true);
    await protectedGroup.locator('summary').click();
    await expect(protectedGroup.getByRole('checkbox')).toHaveCount(3);
    for (const checkbox of await protectedGroup.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
    for (const button of await protectedGroup.getByRole('button').all()) await expect(button).toBeDisabled();
    await expect(protectedGroup).not.toContainText('Sensitive paths are excluded');
    await noHorizontalOverflow(page);
    await protectedGroup.locator('summary').click();
    await page.getByLabel('提交摘要').fill('演示提交，不执行真实 Git');
    const trigger = page.getByRole('button', { name: 'Commit', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('background-color', background[base]);
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    const cancel = dialog.getByRole('button', { name: '取消', exact: true });
    const confirm = dialog.getByRole('button', { name: '确认执行', exact: true });
    await focusVisible(cancel);
    await page.keyboard.press('Shift+Tab'); await focusVisible(confirm);
    await page.keyboard.press('Tab'); await focusVisible(cancel);
    await page.keyboard.press('Tab'); await focusVisible(confirm);
    await page.keyboard.press('Tab'); await focusVisible(cancel);
    await noHorizontalOverflow(page);
    await screenshot(page, `confirm-${width}-${base}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => (window as any).__themeDemo.calls.some((call: any) => call.operation === 'commit'))).toBe(false);
    for (const label of ['分支', '历史', 'Blame', 'Stash', '暂存区', '工作区']) {
      await git.getByRole('button', { name: label, exact: true }).click();
      await expect(git.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
      await noHorizontalOverflow(page);
    }
  });
}

test('host tokens outrank fallback, update live, and survive Git/session switching', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, `base=light&${session}`);
  await page.evaluate(() => {
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries({ '--ds-bg-dock': '#182637', '--ds-text-primary': '#e4eaff', '--ds-text-muted': '#b0bdd0', '--ds-border-default': '#64768c', '--ds-focus': '#97bcff', '--ds-bg-active': '#2a405e' })) style.setProperty(name, value);
  });
  await expect(page.locator('.dv-app')).toHaveCSS('background-color', 'rgb(24, 38, 55)');
  await expect(page.locator('.dv-panel-nav')).toHaveCSS('color', 'rgb(228, 234, 255)');
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.locator('.git-management')).toHaveCSS('color', 'rgb(228, 234, 255)');
  await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
  await page.getByLabel('提交摘要').fill('主题切换演示');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(24, 38, 55)');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ds-bg-dock', '#f3f6fc');
    document.documentElement.style.setProperty('--ds-text-primary', '#18324a');
    (window as any).__demo.changeAppearance({ locale: 'zh-CN', base: 'dark' });
  });
  await expect(page.locator('.git-management')).toHaveAttribute('data-base', 'dark');
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(243, 246, 252)');
  await expect(page.getByRole('dialog')).toHaveCSS('color', 'rgb(24, 50, 74)');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '会话修改', exact: true }).click();
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
  await expect(page.locator('.dv-app')).toHaveCSS('background-color', 'rgb(243, 246, 252)');
  await page.evaluate(() => { document.documentElement.removeAttribute('style'); (window as any).__demo.changeAppearance({ base: 'light' }); });
  await expect(page.locator('.dv-app')).toHaveCSS('background-color', background.light);
  await page.evaluate(() => (window as any).__demo.changeAppearance({ base: 'dark' }));
  await expect(page.locator('.dv-app')).toHaveCSS('background-color', background.dark);
  await page.evaluate(() => (window as any).__demo.changeAppearance({ locale: 'zh-CN' }));
  await expect(page.locator('.dv-app')).toHaveAttribute('data-base', 'dark');
});

test('late initial appearance cannot overwrite a newer appearance event', async ({ page }) => {
  await open(page, 'base=light&appearanceRace=1');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__themeDemo.resolveAppearance)).toBe('function');
  await page.evaluate(() => { (window as any).__demo.changeAppearance({ base: 'dark', locale: 'zh-CN' }); (window as any).__themeDemo.resolveAppearance(); });
  await expect(page.locator('.dv-panel')).toHaveAttribute('data-base', 'dark');
  await expect(page.locator('.dv-panel')).toHaveCSS('background-color', background.dark);
});

test('loading, error retry, empty, disabled, success, protected index and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, 'mode=git&base=dark');
  const git = page.locator('.git-management');
  const refresh = git.getByRole('button', { name: '刷新', exact: true });
  await expect(refresh).toBeEnabled();
  expect(await page.locator('.gm-files li').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.evaluate(() => { (window as any).__themeDemo.delay = 250; (window as any).__themeDemo.failNext = true; });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(git.getByText('正在执行 Git，请勿重复操作…')).toBeVisible();
  await expect(git.getByRole('alert')).toContainText('演示错误');
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => (window as any).__themeDemo.delay = 0);
  await refresh.click(); await expect(git.getByRole('alert')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
  await page.getByRole('button', { name: '暂存所选 (2)', exact: true }).click();
  await expect(git.getByText('操作已完成。')).toBeVisible();
  const stages = await page.evaluate(() => (window as any).__themeDemo.calls.filter((call: any) => call.operation === 'stage'));
  expect(stages).toHaveLength(1); expect(stages[0].paths).toHaveLength(2); expect(stages[0].paths).not.toContain('.env.private');
  await page.getByRole('button', { name: '暂存区', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
  await page.getByLabel('提交摘要').fill('模拟确认');
  const commit = page.getByRole('button', { name: 'Commit', exact: true });
  await commit.click();
  expect(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(git.getByText(/Commit 已创建/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__themeDemo.calls.find((call: any) => call.operation === 'commit').confirmed)).toBe(true);
  await page.evaluate(() => (window as any).__themeDemo.entries.push({ path: '.env.staged', index: 'M', working: ' ', blocked: 'Sensitive paths are excluded' }));
  await refresh.click(); await page.getByLabel('提交摘要').fill('只提交可操作勾选文件');
  await expect(commit).toBeDisabled();
  await page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '选择 .env.staged', exact: true, includeHidden: true })).toBeDisabled();
  await expect(commit).toBeEnabled();
  await page.evaluate(() => (window as any).__themeDemo.entries = []);
  await refresh.click();
  await expect(git.getByText('没有已暂存改动。')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择全部可操作文件', exact: true })).toBeDisabled();
  await expect(commit).toBeDisabled();
  await noHorizontalOverflow(page);
});

for (const width of [360, 600, 1100]) for (const base of ['light', 'dark'] as const) test(`integrated mode navigation at ${width}px ${base} preserves keyboard switching`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 }); await open(page, `base=${base}&${session}`);
  const nav = page.getByRole('navigation', { name: 'Diff view 功能' }), modes = nav.getByRole('group', { name: '功能切换' });
  const sessionButton = modes.getByRole('button', { name: '会话修改', exact: true }), gitButton = modes.getByRole('button', { name: '本地 Git', exact: true });
  await expect(sessionButton).toHaveAttribute('aria-pressed', 'true'); await expect(gitButton).toHaveAttribute('aria-pressed', 'false');
  await expect(modes).toHaveCSS('display', 'flex'); await expect(modes).toHaveCSS('border-radius', '20px');
  await expect(sessionButton).toHaveCSS('border-width', '0px'); await expect(sessionButton).toHaveCSS('font-size', '12px');
  await expect(nav).toHaveCSS('border-bottom-width', '0px');
  expect(await nav.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(44);
  const selectedColor = await sessionButton.evaluate(node => getComputedStyle(node).color);
  expect(selectedColor).toBe(await page.locator('.dv-app').evaluate(node => getComputedStyle(node).color));
  await page.screenshot({ path: info.outputPath(`mode-session-${width}-${base}.png`) });
  await sessionButton.focus(); await page.keyboard.press('Tab'); await expect(gitButton).toBeFocused(); await focusVisible(gitButton);
  await page.keyboard.press('Enter'); await expect(gitButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: '本地 Git 管理' })).toBeVisible(); await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(`mode-git-${width}-${base}.png`) });
  await page.keyboard.press('Shift+Tab'); await expect(sessionButton).toBeFocused(); await page.keyboard.press('Enter');
  await expect(sessionButton).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('.dv-file').first()).toBeVisible();
  await noHorizontalOverflow(page);
});
