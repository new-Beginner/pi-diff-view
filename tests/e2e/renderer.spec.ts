import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
let harness = '';
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/e2e/renderer-harness.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, loader: { '.css': 'empty' } })).outputFiles[0].text;
});
async function setup(page: Page, locale = 'en', query = '') {
  await page.route('**/renderer-demo*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><script src="/mock.js"></script><style>body{margin:0;font:14px/1.7 'Segoe UI',system-ui;background:#fff;color:#30343b}#mock-chat{padding:30px;width:min(880px,100%);box-sizing:border-box;transition:none}body.sidebar-open #mock-chat{width:calc(100% - 640px)}h1{font-size:17px;margin:0 0 26px}.demo-label{color:#7b8290;font-size:12px;padding:8px 16px;background:#f4f6f9}.mock-reply-text{padding:60px 0 12px}.mock-composer{margin-top:90px;border:1px solid #e4e7ec;border-radius:20px;padding:18px 20px;color:#8a929e}#demo-plugin-sidebar{position:fixed;right:0;top:0;bottom:0;width:640px;border-left:1px solid #e4e7ec;background:#fff;display:flex;flex-direction:column}#demo-plugin-sidebar header{padding:10px 14px;border-bottom:1px solid #e4e7ec;display:flex;justify-content:space-between}#demo-plugin-sidebar header button{background:transparent;border:0;cursor:pointer}#demo-plugin-sidebar iframe{width:100%;flex:1;border:0;min-height:0}</style></head><body><div class="demo-label">界面预览 · 测试数据与模拟宿主，不是实际会话验收</div><main id="mock-chat"><h1>Diff view 文末文件变更</h1><div class="mock-reply-text"><p>已完成本次修改，文件变更与检查结果如下。</p><p>点击下面的文件名，在右侧 Diff view 页签查看对应差异。</p></div><article id="mock-reply"></article><div class="mock-composer">与 PI 协作…</div></main></body></html>` }));
  await page.route('**/sidebar-demo*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/mock.js"></script><link rel="stylesheet" href="/index.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/index.js"></script></body></html>' }));
  await page.goto(`/renderer-demo?scenario=renderer&lang=${locale}${query}`); await page.addScriptTag({ content: harness });
  const count = Number(new URLSearchParams(query).get('historyCards') || 1);
  await expect(page.locator('.dv-turn-card')).toHaveCount(count, { timeout: 3000 });
  await expect(page.locator('.dv-turn-file')).toHaveCount(count * 3);
}
test('latest host aggregate is queried first even with long progress and older unbound replies', async ({ page }) => {
  await setup(page, 'en', '&longReply=true&latestAtEnd=true');
  const calls = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.card'));
  expect(calls[0].args.messageId).toBe('reply-demo');
  expect(calls[0].args.content.endsWith('Demo reply 11')).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(calls[0].args.content)).length).toBeLessThanOrEqual(24000);
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('reply-end summary opens the plugin sidebar at the clicked file with no idle floating button or modal', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate(() => (window as any).__rendererDemo.positions)).toEqual([{ slot: 'entryExtra' }, { slot: 'composerControl' }]);
  await expect(page.locator('.dv-running-pill, .dv-layer')).toHaveCount(0);
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe[title="Diff view plugin"]');
  await expect(frame.locator('.dv-review h2')).toHaveText('src/theme/index.ts');
  await expect(frame.getByRole('navigation', { name: 'Diff view 功能' })).toBeVisible();
  await expect(frame.getByRole('combobox', { name: 'Scope' })).toHaveValue('turn');
  expect(await frame.getByRole('combobox', { name: 'Scope' }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['lastTurn', 'turn']);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.find((call: any) => call.method === 'diff.review').args)).toMatchObject({ scope: 'turn', sessionId: 'session-demo' });
  const opens = await page.evaluate(() => (window as any).__rendererDemo.opens);
  expect(opens).toHaveLength(1); expect(opens[0]).toMatchObject({ sessionId: 'session-demo', tab: { id: 'plugin:local.diff-view/review', resource: 'local.diff-view/review' } });
  expect(opens[0].tab.location).toMatch(/^diff-view:[0-9a-f-]{36}\?sessionId=session-demo$/);
  expect(await page.evaluate(() => (window as any).__rendererDemo.draft)).toBe('Existing draft. ');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-turn-card, #demo-plugin-sidebar')).toHaveCount(0);
  expect(await page.evaluate(() => { const state = (window as any).__rendererDemo; return [state.styles, state.sidebars, state.subscriptions]; })).toEqual([0, 0, 0]);
  await page.waitForTimeout(400); const before = await page.evaluate(() => (window as any).__demo.calls.length);
  await page.waitForTimeout(6400); expect(await page.evaluate(() => (window as any).__demo.calls.length)).toBe(before);
});
test('file expansion is cached, external files are labelled, and collapse restores first three', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: /Show 1 more files/ }).click();
  await expect(page.locator('.dv-turn-file')).toHaveCount(4);
  await expect(page.locator('.dv-turn-file').last()).toContainText('Outside workspace · read-only');
  const before = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.turnSummary').length);
  await page.getByRole('button', { name: /Collapse files/ }).click(); await expect(page.locator('.dv-turn-file')).toHaveCount(3);
  await page.getByRole('button', { name: /Show 1 more files/ }).click(); await expect(page.locator('.dv-turn-file')).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.turnSummary').length)).toBe(before);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('an old-session click cannot open a sidebar in the new session', async ({ page }) => {
  await setup(page); await page.evaluate(() => (window as any).__rendererDemo.switchSession('other-session'));
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session changed');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(0);
  await expect(page.locator('.dv-layer, #demo-plugin-sidebar')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('chat summary and sidebar visual preview uses the implemented components', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await setup(page, 'zh-CN');
  await page.locator('.dv-turn-file').filter({ hasText: 'src/review/index.ts' }).click();
  await expect(page.frameLocator('iframe').locator('.dv-hunk')).toHaveCount(2);
  const destination = info.outputPath('task-summary-sidebar.png'); await fs.mkdir(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('an existing plugin view receives a new selection through view:open without reloading', async ({ page }) => {
  await setup(page); await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-review h2')).toHaveText('src/theme/index.ts');
  const nonce = await page.evaluate(async () => (await (window as any).pluginBridge.invoke('diff.selectTurn', { sessionId: 'session-demo', runId: 'run-demo', fileId: 'review' })).nonce);
  await frame.locator('body').evaluate((_element, value) => (window as any).__demo.openLocation(`diff-view:${value}?sessionId=session-demo`), nonce);
  await expect(frame.locator('.dv-review h2')).toHaveText('src/review/index.ts');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('View changes opens the first file without treating a draft snapshot as a session', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.frameLocator('iframe').locator('.dv-review h2')).toHaveText('src/review/index.ts');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__rendererDemo.draft)).toBe('Existing draft. ');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
for (const returnBack of [false, true]) test(`a session switch during selection rejects the pending click${returnBack ? ' even after returning' : ''}`, async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (method: string, args: any, internal: boolean) => {
      if (method === 'diff.selectTurn') {
        (window as any).__selectionWaiting = true;
        await new Promise<void>(resolve => { (window as any).__finishSelection = resolve; });
      }
      return invoke(method, args, internal);
    };
  });
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__selectionWaiting)).toBe(true);
  await page.evaluate(back => {
    const state = (window as any).__rendererDemo; state.switchSession('other-session');
    if (back) state.switchSession('session-demo');
    (window as any).__finishSelection();
  }, returnBack);
  await expect(page.getByRole('alert')).toContainText('Session changed');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(0);
  await expect(page.locator('#demo-plugin-sidebar')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('new-session initialization with no active id recovers without poisoning the click promise', async ({ page }) => {
  await setup(page, 'en', '&newSession=true&persisted=true');
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session changed');
  await expect(page.getByRole('alert')).not.toContainText('Invalid host session state');
  await page.evaluate(() => (window as any).__rendererDemo.switchSession('session-demo'));
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.frameLocator('iframe').locator('.dv-review h2')).toHaveText('src/review/index.ts');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('24 durable history cards restore together without per-reply matching or repeated summary loads', async ({ page }) => {
  await setup(page, 'en', '&historyCards=24');
  const calls = await page.evaluate(() => (window as any).__demo.calls);
  expect(calls.filter((call: any) => call.method === 'diff.card' || call.method === 'diff.turnSummary' || call.method === 'diff.bootstrap')).toHaveLength(0);
  expect(calls.filter((call: any) => call.method === 'diff.replyCards')).toHaveLength(2);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('cached history stays immediately visible on remount even while the bridge is unavailable, then clears explicitly', async ({ page }) => {
  await setup(page, 'en', '&persisted=true');
  await page.evaluate(() => { (window as any).__demo.failFeed = true; (window as any).__rendererDemo.hideReplies(); });
  await expect(page.locator('.dv-turn-card')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.showReplies());
  await expect(page.locator('.dv-turn-file')).toHaveCount(3, { timeout: 300 });
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.waitForTimeout(2500); await expect(page.locator('.dv-turn-file')).toHaveCount(3);
  await page.evaluate(async () => { (window as any).__demo.failFeed = false; await (window as any).pluginBridge.invoke('diff.clearHistory', { confirmed: true }); });
  await expect(page.locator('.dv-turn-card')).toHaveCount(0, { timeout: 4000 });
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('chat card inherits host colors live and omits the capture notice', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.dv-turn-notice')).toHaveCount(0);
  await expect(page.locator('.dv-turn-card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  for (const [bg, ink, expected] of [['#faf2ec', '#40302a', 'rgb(64, 48, 42)'], ['#152a22', '#eefaf2', 'rgb(238, 250, 242)']]) {
    await page.evaluate(([bg, ink]) => { document.body.style.background = bg; document.body.style.color = ink; document.documentElement.style.setProperty('--ds-text-primary', ink); }, [bg, ink]);
    await expect(page.locator('.dv-turn-card')).toHaveCSS('color', expected);
    await expect(page.locator('.dv-turn-card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('successive chat-file clicks reuse the panel and only expand the target diff', async ({ page }) => {
  await setup(page); await page.locator('.dv-turn-file').filter({ hasText: 'src/review/index.ts' }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-hunk')).toHaveCount(2);
  await frame.locator('.dv-top .dv-menu > summary').click(); await frame.getByRole('button', { name: 'Split', exact: true }).click(); await frame.locator('.dv-top .dv-menu > summary').click();
  await frame.locator('.dv-app').evaluate(node => { (window as any).__originalApp = node; (window as any).__originalDocument = document; });
  const before = await frame.locator('body').evaluate(() => ({ bootstrap: (window as any).__demo.calls.filter((call: any) => call.method === 'diff.bootstrap').length, review: (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').length }));
  await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  await expect(frame.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts');
  await expect(frame.locator('.dv-file').filter({ hasText: 'src/review/index.ts' })).toHaveAttribute('aria-expanded', 'false');
  await expect(frame.locator('.dv-file').filter({ hasText: 'src/theme/index.ts' })).toHaveAttribute('aria-expanded', 'true');
  await expect(frame.locator('.dv-split')).toHaveCount(1);
  await expect(frame.locator('.dv-code').filter({ hasText: 'export const theme' })).toHaveCount(1);
  await frame.locator('.dv-file[aria-current="true"]').click(); await expect(frame.locator('.dv-review')).toBeHidden();
  await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click(); await expect(frame.locator('.dv-review')).toBeVisible();
  await page.locator('.dv-turn-file').filter({ hasText: 'src/review/index.ts' }).click(); await expect(frame.locator('.dv-split')).toHaveCount(2);
  expect(await frame.locator('.dv-app').evaluate(node => node === (window as any).__originalApp && document === (window as any).__originalDocument)).toBe(true);
  expect(await frame.locator('body').evaluate(() => ({ bootstrap: (window as any).__demo.calls.filter((call: any) => call.method === 'diff.bootstrap').length, review: (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').length }))).toEqual(before);
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('a different recorded turn switches in place and refreshes only its file list', async ({ page }) => {
  await setup(page); await page.locator('.dv-turn-file').first().click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-hunk')).toHaveCount(2);
  await frame.locator('.dv-app').evaluate(node => { (window as any).__originalApp = node; });
  const nonce = await page.evaluate(async () => (await (window as any).pluginBridge.invoke('diff.selectTurn', { sessionId: 'session-demo', runId: 'another-run', fileId: 'created' })).nonce);
  await expect(frame.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts'); await expect(frame.locator('.dv-hunk')).toHaveCount(1);
  expect(await frame.locator('.dv-app').evaluate(node => node === (window as any).__originalApp)).toBe(true);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.bootstrap').length)).toBe(1);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').at(-1).args.runId)).toBe('another-run');
  expect(await page.evaluate(value => (window as any).__rendererDemo.opens[0].tab.location === `diff-view:${value}?sessionId=session-demo`, nonce)).toBe(true);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

for (const width of [360, 900]) test(`Codex-style card hierarchy and path contrast at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 700 }); await setup(page, 'zh-CN');
  await expect(page.locator('.dv-turn-label strong')).toHaveText('已编辑 4 个文件');
  await expect(page.locator('.dv-turn-icon svg')).toBeVisible();
  const hierarchy = await page.locator('.dv-turn-label').evaluate(node => { const title = node.querySelector('strong')!.getBoundingClientRect(), counts = node.querySelector('.dv-turn-counts')!.getBoundingClientRect(); return counts.top >= title.bottom; }); expect(hierarchy).toBe(true);
  const file = page.locator('.dv-turn-file').first(); await expect(file.locator('.dv-path-directory')).toHaveText('src/review/'); await expect(file.locator('.dv-path-basename')).toHaveText('index.ts');
  expect(await file.evaluate(node => getComputedStyle(node.querySelector('.dv-path-directory')!).color !== getComputedStyle(node.querySelector('.dv-path-basename')!).color)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath(`card-${width}.png`) }); await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('unknown statistics use a compact disclosure and stay aligned on narrow screens', async ({ page }, info) => {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value; const invoke = value.invoke.bind(value);
      value.invoke = async (method: string, args: any, internal: boolean) => {
        const result = await invoke(method, args, internal);
        if (method === 'diff.replyCards') for (const card of result.cards) {
          card.summary.unknownFileCount = 1;
          card.summary.files[0] = { ...card.summary.files[0], path: 'package-lock.json', kind: 'unavailable', statsKnown: false, additions: 0, deletions: 0 };
        }
        return result;
      };
    } });
  });
  await setup(page, 'zh-CN', '&persisted=true');
  await expect(page.locator('.dv-turn-file').first()).toContainText('行数未知');
  await expect(page.locator('.dv-turn-file').first().locator('.dv-turn-counts')).toHaveCount(0);
  await expect(page.locator('.dv-turn-card')).not.toContainText('unavailable');
  await expect(page.locator('.dv-turn-stats-note p')).toBeHidden();
  for (const width of [360, 900]) {
    await page.setViewportSize({ width, height: 650 });
    expect(await page.locator('.dv-turn-card').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`unknown-card-${width}.png`) });
  }
  await page.locator('.dv-turn-stats-note summary').click();
  await expect(page.locator('.dv-turn-stats-note p')).toBeVisible();
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
