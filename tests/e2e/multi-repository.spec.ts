import { test, expect } from '@playwright/test';

// Production Panel + simulated bridge; real Git discovery is covered by integration tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value; const invoke = value.invoke.bind(value);
      const demo = (window as any).__demo; demo.repoCalls = [];
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.bootstrap') {
          demo.repoCalls.push({ method, ...args });
          const result = await invoke(method, args, internal);
          return { ...result, workspaceKey: 'projects', repositories: [{ root: '/projects', name: 'projects', git: false }, ...['one', 'two'].filter(name => name !== demo.removed).map(name => ({ root: '/projects/' + name, name, git: true }))], selectedRepository: args.sessionId === 'session-b' ? '/projects/one' : localStorage.getItem('repo:' + args.sessionId) || '/projects/one' };
        }
        if (method === 'diff.selectRepository') { demo.repoCalls.push({ method, ...args }); localStorage.setItem('repo:' + args.sessionId, args.root); return { ok: true }; }
        if (method === 'diff.gitManage') {
          demo.repoCalls.push({ method, ...args });
          if (demo.holdGit) await new Promise<void>(resolve => demo.releaseGit = resolve);
          const repository = { root: args.root, branch: 'main', head: 'oid', entries: [] };
          if (args.operation === 'branches') return { repository, branches: [] };
          return repository;
        }
        return invoke(method, args, internal);
      };
    } });
  });
});
const route = (id: string) => `diff-session:${id}?sessionId=${id}`;

test('repository and page restore immediately across A → B → A, without rescanning or rebuilding', async ({ page }) => {
  await page.goto('/?scenario=panel&piViewOpen=' + encodeURIComponent(route('session-a')));
  await expect(page.locator('.dv-review:visible')).toBeVisible();
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Git 项目', exact: true });
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(2);
  await select.selectOption('/projects/two');
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/two');
  await page.locator('.git-management:visible').getByLabel('提交摘要').fill('keep draft');
  await page.getByRole('button', { name: '分支', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.locator('.git-management:visible').evaluate(node => (window as any).__gitNode = node);
  await page.evaluate(r => (window as any).__demo.openLocation(r), route('session-b'));
  await expect(page.locator('.dv-review:visible h2')).toContainText('session-b/');
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(select).toHaveValue('/projects/one');
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  const before = await page.evaluate(() => (window as any).__demo.repoCalls.length);
  await page.evaluate(r => { (window as any).__demo.holdGit = true; (window as any).__demo.openLocation(r); }, route('session-a'));
  await expect(select).toHaveValue('/projects/two', { timeout: 500 });
  await expect(page.getByRole('button', { name: '分支', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.git-management:visible').evaluate(node => node === (window as any).__gitNode)).toBe(true);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).__demo.repoCalls.length)).toBe(before);
  await page.evaluate(() => { (window as any).__demo.holdGit = false; });
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await expect(page.locator('.git-management:visible').getByLabel('提交摘要')).toHaveValue('keep draft');
  await page.evaluate(() => { (window as any).__demo.holdGit = false; (window as any).__demo.releaseGit?.(); });
  await page.reload();
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(select).toHaveValue('/projects/two');
});

test('a missing saved repository and explicit rescan never fall back to the first repository', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('repo:session-a', '/projects/missing'));
  await page.goto('/?scenario=panel&piViewOpen=' + encodeURIComponent(route('session-a')));
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Git 项目', exact: true });
  await expect(page.getByText('已选仓库不在当前扫描列表中：', { exact: false })).toBeVisible();
  await expect(page.locator('.git-management:visible')).toHaveCount(0);
  await expect(select).toHaveValue('');
  await select.selectOption('/projects/two');
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/two');
  await page.evaluate(() => (window as any).__demo.removed = 'two');
  await page.getByRole('button', { name: '重新扫描仓库', exact: true }).click();
  await expect(page.getByText('已选仓库不在当前扫描列表中：', { exact: false })).toBeVisible();
  await expect(select).toHaveValue('');
  await expect(page.locator('.git-management:visible')).toHaveCount(0);
  await select.selectOption('/projects/one');
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/one');
});

test('late repository reads only update their own cached instance', async ({ page }) => {
  await page.goto('/?scenario=panel&piViewOpen=' + encodeURIComponent(route('session-a')));
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Git 项目', exact: true });
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/one');
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__demo.holdGit = true);
  await select.selectOption('/projects/two');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__demo.releaseGit)).toBe('function');
  await select.selectOption('/projects/one');
  await page.evaluate(() => { (window as any).__demo.holdGit = false; (window as any).__demo.releaseGit(); });
  await page.waitForTimeout(200);
  await expect(select).toHaveValue('/projects/one');
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/one');
  await select.selectOption('/projects/two');
  await expect(page.locator('.gm-root:visible')).toContainText('/projects/two');
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
});

for (const width of [360, 1100]) test(`repository selector fits the panel at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/?scenario=panel&piViewOpen=' + encodeURIComponent(route('session-a')));
  await page.getByRole('button', { name: '本地 Git', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Git 项目', exact: true })).toHaveValue('/projects/one');
  expect(await page.locator('.dv-git-repositories:visible').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '重新扫描仓库', exact: true })).toBeVisible();
});
