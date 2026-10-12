import { test, expect, type Page } from '@playwright/test';
// Production Panel bundle, mocked bridge only: not native-host acceptance.
const nonce = '00000000-0000-4000-8000-000000000123';
const url = (route = '') => '/?scenario=panel' + (route ? `&piViewOpen=${encodeURIComponent(route)}` : '');
const sessionRoute = (id: string) => `diff-session:${id}?sessionId=${id}`;
const selectionRoute = (id: string) => `diff-view:${nonce}?sessionId=${id}`;
const calls = (page: Page, method: string) => page.evaluate(method => (window as any).__demo.calls.filter((call: any) => call.method === method), method);
async function seed(page: Page) {
  await page.addInitScript(({ nonce }) => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const demo = (window as any).__demo;
      demo.navigation.set(nonce, { nonce, revision: 1, sessionId: 'session-a', request: { scope: 'turn', root: 'D:/projects/diff-view', sessionId: 'session-a', runId: 'run-session-a' }, fileId: 'created' });
    } });
  }, { nonce });
}
for (const route of ['', `diff-view:${nonce}`]) test(`identity-free Panel refuses global history (${route ? 'legacy selection' : 'blank entry'})`, async ({ page }) => {
  await seed(page); await page.goto(url(route));
  await expect(page.getByText(route ? '旧版视图没有会话标识' : '缺少会话身份', { exact: false })).toBeVisible();
  await page.waitForTimeout(1100);
  await expect(page.locator('.dv-file, .dv-hunk')).toHaveCount(0);
  for (const method of ['diff.bootstrap', 'diff.review', 'diff.readTurnSelection']) expect(await calls(page, method)).toHaveLength(0);
});

test('identity-free local Git remains independent and returning to session never loads global history', async ({ page }) => {
  await page.goto(url());
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.getByRole('region', { name: '本地 Git 管理' })).toBeVisible();
  await expect.poll(async () => (await calls(page, 'diff.gitManage')).length).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '会话修改', exact: true }).click();
  await expect(page.getByText('缺少会话身份', { exact: false })).toBeVisible();
  expect(await calls(page, 'diff.review')).toHaveLength(0);
});

test('two parallel session panels stay scoped; late selection after session change cannot leak', async ({ page, context }) => {
  const other = await context.newPage();
  await seed(page); await seed(other);
  await Promise.all([page.goto(url(sessionRoute('session-a'))), other.goto(url(sessionRoute('session-b')))]);
  await expect(page.locator('.dv-review h2')).toHaveText('session-a/src/review/index.ts');
  await expect(other.locator('.dv-review h2')).toHaveText('session-b/src/review/index.ts');
  for (const [panel, id] of [[page, 'session-a'], [other, 'session-b']] as const) {
    for (const method of ['diff.bootstrap', 'diff.review']) {
      const requests = await calls(panel, method); expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((call: any) => call.args.sessionId === id)).toBe(true);
    }
  }
  await page.evaluate(route => {
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (method: string, args: any, internal: boolean) => {
      const result = await invoke(method, args, internal);
      if (method === 'diff.readTurnSelection') {
        (window as any).__selectionWaiting = true;
        await new Promise<void>(resolve => (window as any).__releaseSelection = resolve);
      }
      return result;
    };
    (window as any).__demo.openLocation(route);
  }, selectionRoute('session-a'));
  await expect.poll(() => page.evaluate(() => (window as any).__selectionWaiting)).toBe(true);
  await page.evaluate(route => (window as any).__demo.openLocation(route), sessionRoute('session-b'));
  await expect(page.locator('.dv-review h2')).toHaveText('session-b/src/review/index.ts');
  await page.evaluate(() => (window as any).__releaseSelection()); await page.waitForTimeout(1200);
  for (const panel of [page, other]) {
    await expect(panel.locator('.dv-review h2')).toHaveText('session-b/src/review/index.ts');
    await expect(panel.locator('.dv-file').filter({ hasText: 'session-a/' })).toHaveCount(0);
  }
  expect((await calls(page, 'diff.readTurnSelection'))[0].args).toEqual({ nonce, sessionId: 'session-a' });
  await other.close();
});

test('selection errors allow retry and fallback to only this session, including Git round-trip', async ({ page }) => {
  await seed(page); await page.goto(url(selectionRoute('session-b')));
  await expect(page.getByRole('alert')).toContainText('Demo selection belongs to another session');
  await expect(page.locator('.dv-file')).toHaveCount(0);
  await page.evaluate(({ nonce }) => {
    const demo = (window as any).__demo;
    demo.navigation.set(nonce, { ...demo.navigation.get(nonce), sessionId: 'session-b', request: { scope: 'turn', root: 'D:/projects/diff-view', sessionId: 'session-b', runId: 'run-session-b' } });
  }, { nonce });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.dv-review h2')).toHaveText('session-b/src/theme/index.ts');
  await page.evaluate(route => { (window as any).__demo.navigation.clear(); (window as any).__demo.openLocation(route); }, selectionRoute('session-b'));
  await expect(page.getByRole('alert')).toContainText('Demo selection expired');
  await page.getByRole('button', { name: '返回本会话修改记录', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('lastTurn');
  await expect(page.locator('.dv-review h2')).toHaveText('session-b/src/review/index.ts');
  expect((await calls(page, 'diff.review')).at(-1).args).toMatchObject({ scope: 'lastTurn', sessionId: 'session-b' });
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.getByRole('region', { name: '本地 Git 管理' })).toBeVisible();
  await page.getByRole('button', { name: '会话修改', exact: true }).click();
  await expect(page.locator('.dv-review h2')).toHaveText('session-b/src/review/index.ts');
  await expect(page.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('lastTurn');
  expect((await calls(page, 'diff.review')).every((call: any) => call.args.sessionId === 'session-b')).toBe(true);
});
