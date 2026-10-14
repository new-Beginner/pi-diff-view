import { test, expect, type Page } from '@playwright/test';
import { selectScope } from './scope-helpers';
// Production Panel with a session-scoped mock bridge. Native-host acceptance is separate.
const route = (id = 'session-a') => `diff-session:${id}?sessionId=${id}`;
async function setup(page: Page) {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value), demo = (window as any).__demo;
      const currentRoot = 'D:/projects/current', historicalRoot = 'D:/projects/historical';
      const state = (window as any).__latest = { currentFiles: false, currentState: 'running', holdNext: false, waiting: false, release: undefined as any, reviews: new Map() };
      const runs = (sessionId: string) => [
        { id: `${sessionId}-current`, sessionId, root: currentRoot, startedAt: 1750000200000, state: state.currentState, fileCount: state.currentFiles ? 1 : 0, incomplete: false },
        { id: `${sessionId}-previous`, sessionId, root: currentRoot, startedAt: 1750000100000, endedAt: 1750000101000, state: 'completed', fileCount: 1, incomplete: false },
        { id: `${sessionId}-historical`, sessionId, root: historicalRoot, startedAt: 1750000000000, endedAt: 1750000001000, state: 'completed', fileCount: 1, incomplete: false },
      ];
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.review') {
          const run = runs(args.sessionId).find(r => args.scope === 'turn' ? r.id === args.runId : r.fileCount > 0 && (!args.root || r.root === args.root));
          const hold = state.holdNext && args.sessionId === 'session-a';
          if (hold) state.holdNext = false;
          const result = await invoke(method, args, internal);
          result.root = run?.root ?? args.root ?? ''; result.runId = run?.id; result.run = run;
          result.id = `${args.sessionId}:${args.scope}:${run?.id ?? 'empty'}:${run?.state}`;
          result.files = run?.fileCount ? [{ ...result.files[0], path: `${args.sessionId}/${run.id.endsWith('-current') ? 'current' : run.id.endsWith('-historical') ? 'historical' : 'previous'}.ts`, fingerprint: run.id, actions: [] }] : [];
          state.reviews.set(result.id, result); demo.review = result;
          if (hold) { state.waiting = true; await new Promise<void>(resolve => state.release = resolve); }
          return result;
        }
        const result = await invoke(method, args, internal);
        if (method === 'diff.bootstrap') {
          result.runs = runs(args.sessionId);
          result.repositories = [currentRoot, historicalRoot].map(root => ({ root, name: root, git: false }));
        }
        if (method === 'diff.file') result.file = state.reviews.get(args.reviewId)?.files.find((file: any) => file.id === args.fileId);
        return result;
      };
    } });
  });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent(route()));
  await expect(page.locator('.dv-review:visible h2')).toHaveText('session-a/previous.ts');
}
const scope = (page: Page) => page.getByRole('combobox', { name: '范围', exact: true });
const title = (page: Page) => page.locator('.dv-review:visible h2');

test('latest modified view follows changes and completion without a redundant turn label', async ({ page }) => {
  await setup(page);
  await expect(scope(page)).toContainText('最近轮次');
  await expect(page.locator('.dv-turn-identity')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__latest.currentFiles = true; });
  await expect(title(page)).toHaveText('session-a/current.ts');
  await page.evaluate(() => { (window as any).__latest.currentState = 'completed'; });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.review.run?.state)).toBe('completed');
  await expect(title(page)).toHaveText('session-a/current.ts');
});

test('history round-trip drops inherited roots but preserves an explicitly chosen latest root', async ({ page }) => {
  await setup(page);
  await selectScope(scope(page), 'turn');
  await page.getByRole('combobox', { name: '对话轮次', exact: true }).selectOption('session-a-historical');
  await expect(title(page)).toHaveText('session-a/historical.ts');
  await page.evaluate(() => { (window as any).__latest.currentFiles = true; });
  await selectScope(scope(page), 'lastTurn');
  await expect(title(page)).toHaveText('session-a/current.ts');
  const requests = await page.evaluate(() => (window as any).__demo.calls.filter((c: any) => c.method === 'diff.review' && c.args.scope === 'lastTurn'));
  expect(requests.at(-1).args.root).toBeUndefined();
  await page.getByTitle('显示设置', { exact: true }).click();
  await page.getByRole('combobox', { name: '仓库', exact: true }).selectOption('D:/projects/historical');
  await page.keyboard.press('Escape');
  await expect(title(page)).toHaveText('session-a/historical.ts');
  await selectScope(scope(page), 'turn');
  await expect(title(page)).toHaveText('session-a/historical.ts');
  await page.waitForTimeout(1000); // Latest polling must not override exact historical selection.
  await expect(title(page)).toHaveText('session-a/historical.ts');
  await selectScope(scope(page), 'lastTurn');
  await expect(title(page)).toHaveText('session-a/historical.ts');
  await page.getByTitle('显示设置', { exact: true }).click();
  await page.getByRole('combobox', { name: '仓库', exact: true }).selectOption('');
  await page.keyboard.press('Escape');
  await expect(title(page)).toHaveText('session-a/current.ts');
});

test('A to B to A revalidates immediately, retaining nodes, selected file, folds and scroll', async ({ page }) => {
  await setup(page);
  await page.locator('[data-hunk-nav]:visible').first().click();
  await page.evaluate(() => {
    const app = document.querySelector('.dv-app')!, hunk = document.querySelector('.dv-hunk')!, pane = document.querySelector('.dv-workspace')!;
    (pane as HTMLElement).style.maxHeight = '100px'; pane.scrollTop = 40;
    (window as any).__retained = { app, hunk, scroll: pane.scrollTop, file: document.querySelector('.dv-file[aria-current="true"]') };
    (window as any).__demo.openLocation('diff-session:session-b?sessionId=session-b');
  });
  await expect(title(page)).toHaveText('session-b/previous.ts');
  const before = await page.evaluate(() => (window as any).__demo.calls.filter((c: any) => c.method === 'diff.review' && c.args.sessionId === 'session-a').length);
  // Isolate activation latency from the separate six-request rolling admission cap.
  await page.evaluate(() => { (window as any).__piDiffBurstQueue.starts = []; (window as any).__demo.openLocation('diff-session:session-a?sessionId=session-a'); });
  await expect(title(page)).toHaveText('session-a/previous.ts');
  await expect.poll(() => page.evaluate(() => (window as any).__demo.calls.filter((c: any) => c.method === 'diff.review' && c.args.sessionId === 'session-a').length), { timeout: 500 }).toBeGreaterThan(before);
  await expect(page.locator('[data-hunk-nav]:visible').first()).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => { const r = (window as any).__retained; return r.app === document.querySelector('.dv-app:not([hidden])') && r.hunk.isConnected && r.file.isConnected; })).toBe(true);
  expect(await page.locator('.dv-workspace:visible').evaluate(node => node.scrollTop)).toBe(await page.evaluate(() => (window as any).__retained.scroll));
});

test('a pre-switch delayed latest result cannot overwrite new current changes after returning to A', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__latest.holdNext = true; });
  await expect.poll(() => page.evaluate(() => (window as any).__latest.waiting)).toBe(true);
  await page.evaluate(() => (window as any).__demo.openLocation('diff-session:session-b?sessionId=session-b'));
  await expect(title(page)).toHaveText('session-b/previous.ts');
  await page.evaluate(() => { (window as any).__piDiffBurstQueue.starts = []; (window as any).__latest.currentFiles = true; (window as any).__demo.openLocation('diff-session:session-a?sessionId=session-a'); });
  await expect(title(page)).toHaveText('session-a/current.ts');
  await page.evaluate(() => (window as any).__latest.release());
  await page.waitForTimeout(350);
  await expect(title(page)).toHaveText('session-a/current.ts');
  await expect(page.locator('.dv-file:visible')).not.toContainText('session-b/');
});
