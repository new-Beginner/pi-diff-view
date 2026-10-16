import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ReviewSurfaces } from '../../src/core/review-surfaces';
let harness = '';
test.beforeAll(async () => {
  harness = (await build({ entryPoints: ['tests/e2e/renderer-harness.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, loader: { '.css': 'empty' } })).outputFiles[0].text;
});
async function setup(page: Page, locale = 'en', query = '', filesPerCard = 4, expectedCards?: number) {
  const surfaces = new ReviewSurfaces();
  await page.route('**/surface-rpc', async route => { const result = await surfaces.request(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) }); });
  await page.route('**/renderer-demo*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><script src="/mock.js"></script><style>body{margin:0;font:14px/1.7 'Segoe UI',system-ui;background:#fff;color:#30343b}#mock-chat{padding:30px;width:min(880px,100%);box-sizing:border-box;transition:none}body.sidebar-open #mock-chat{width:calc(100% - 640px)}h1{font-size:17px;margin:0 0 26px}.demo-label{color:#7b8290;font-size:12px;padding:8px 16px;background:#f4f6f9}.mock-reply-text{padding:60px 0 12px}.mock-composer{margin-top:90px;border:1px solid #e4e7ec;border-radius:20px;padding:18px 20px;color:#8a929e}#demo-plugin-sidebar{position:fixed;right:0;top:0;bottom:0;width:640px;border-left:1px solid #e4e7ec;background:#fff;display:flex;flex-direction:column}#demo-plugin-sidebar header{padding:10px 14px;border-bottom:1px solid #e4e7ec;display:flex;justify-content:space-between}#demo-plugin-sidebar header button{background:transparent;border:0;cursor:pointer}#demo-plugin-sidebar iframe{width:100%;flex:1;border:0;min-height:0}</style></head><body><div class="demo-label">界面预览 · 测试数据与模拟宿主，不是实际会话验收</div><main id="mock-chat"><h1>Diff view 文末文件变更</h1><div class="mock-reply-text"><p>已完成本次修改，文件变更与检查结果如下。</p><p>点击下面的文件名，在右侧 Diff view 页签查看对应差异。</p></div><article id="mock-reply"></article><div class="mock-composer">与 PI 协作…</div></main></body></html>` }));
  await page.route('**/sidebar-demo*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/mock.js"></script><link rel="stylesheet" href="/index.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/index.js"></script></body></html>' }));
  await page.goto(`/renderer-demo?scenario=renderer&lang=${locale}${query}`);
  if (query.includes('base=dark')) await page.addStyleTag({ content: 'body{background:#212121;color:#eeeeee;--ds-bg-elevated-opaque:#212121}' });
  if (query.includes('hostFold=true')) await page.evaluate(() => {
    const article = document.getElementById('mock-reply')!;
    const css = document.createElement('style');
    css.textContent = '.pi-entry-extra-viewport{overflow:hidden}.pi-entry-extra-viewport[data-expanded=true]{overflow-y:auto;overscroll-behavior:contain}.pi-entry-extra-viewport[data-clipped=true]{mask-image:linear-gradient(to bottom,#000 92%,transparent)}';
    document.head.append(css);
    const block = document.createElement('div'); block.className = 'pi-entry-extra-block';
    const viewport = document.createElement('div'); viewport.className = 'pi-entry-extra-viewport'; const limit = new URLSearchParams(location.search).get('hostLimit') || '280'; viewport.style.maxHeight = `${limit}px`;
    const content = document.createElement('div'); article.before(block); block.append(viewport); viewport.append(content); content.append(article);
    const toggle = document.createElement('button'); toggle.className = 'pi-entry-extra-toggle'; toggle.textContent = '展开完整内容'; toggle.setAttribute('aria-expanded', 'false');
    const measure = () => { const expanded = viewport.dataset.expanded === 'true', clipped = content.scrollHeight > viewport.clientHeight + 1; viewport.dataset.clipped = String(clipped); toggle.hidden = !expanded && !clipped; toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起内容' : '展开完整内容'; };
    toggle.onclick = () => { const open = viewport.dataset.expanded !== 'true'; if (open) viewport.dataset.expanded = 'true'; else delete viewport.dataset.expanded; viewport.style.maxHeight = open ? '480px' : `${limit}px`; measure(); };
    const resize = new ResizeObserver(measure); resize.observe(content); resize.observe(viewport);
    new MutationObserver(measure).observe(viewport, { attributes: true, attributeFilter: ['data-expanded'] });
    block.append(toggle);
    const other = block.cloneNode(false) as HTMLElement; other.id = 'other-plugin'; other.innerHTML = '<div class="pi-entry-extra-viewport" data-expanded="true" style="max-height:480px"><div style="height:900px">Other plugin</div></div>'; block.after(other);
  });
  await page.addScriptTag({ content: harness });
  const count = expectedCards ?? Number(new URLSearchParams(query).get('historyCards') || 1);
  await expect(page.locator('.dv-turn-card')).toHaveCount(count, { timeout: 3000 });
  await expect(page.locator('.dv-turn-file')).toHaveCount(count * filesPerCard);
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
  const scope = frame.getByRole('combobox', { name: 'Scope' });
  await expect(scope).toHaveAttribute('data-value', 'turn');
  await scope.click();
  expect(await frame.getByRole('listbox').getByRole('option').evaluateAll(options => options.map(option => (option as HTMLElement).dataset.value))).toEqual(['lastTurn', 'turn']);
  await scope.press('Escape');
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.find((call: any) => call.method === 'diff.review').args)).toMatchObject({ scope: 'turn', sessionId: 'session-demo' });
  const opens = await page.evaluate(() => (window as any).__rendererDemo.opens);
  expect(opens).toHaveLength(1); expect(opens[0]).toMatchObject({ sessionId: 'session-demo', tab: { id: 'plugin:local.diff-view/review', resource: 'local.diff-view/review' } });
  expect(await frame.locator('body').evaluate(() => new URLSearchParams(location.search).has('piViewOpen'))).toBe(false);
  expect(await page.evaluate(() => (window as any).__rendererDemo.draft)).toBe('Existing draft. ');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-turn-card, #demo-plugin-sidebar')).toHaveCount(0);
  expect(await page.evaluate(() => { const state = (window as any).__rendererDemo; return [state.styles, state.sidebars, state.subscriptions]; })).toEqual([0, 0, 0]);
  await page.waitForTimeout(400); const before = await page.evaluate(() => (window as any).__demo.calls.length);
  await page.waitForTimeout(6400); expect(await page.evaluate(() => (window as any).__demo.calls.length)).toBe(before);
});
test('ordinary cards expose all files without a second plugin expansion or per-card page request', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.dv-turn-file')).toHaveCount(4);
  await expect(page.locator('.dv-turn-file').last()).toContainText('Outside workspace · read-only');
  await expect(page.getByRole('button', { name: /Show .*more files|Collapse files|Load more files/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.turnSummary').length)).toBe(0);
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
test('an existing plugin view receives a new selection through the plugin handshake without reloading', async ({ page }) => {
  await setup(page); await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-review h2')).toHaveText('src/theme/index.ts');
  await expect(page.locator('.dv-turn-file').first()).toBeEnabled();
  await frame.locator('body').evaluate(() => (window as any).__retainedInstance = 'same');
  await page.locator('.dv-turn-file').filter({ hasText: 'src/review/index.ts' }).click();
  await expect(frame.locator('.dv-review h2')).toHaveText('src/review/index.ts');
  expect(await frame.locator('body').evaluate(() => (window as any).__retainedInstance)).toBe('same');
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
  // The container may reveal immediately; no old-session target may be read/applied.
  expect(await page.frameLocator('iframe').locator('.dv-file').count()).toBe(0);
  await page.evaluate(back => {
    const state = (window as any).__rendererDemo; state.switchSession('other-session');
    if (back) state.switchSession('session-demo');
    (window as any).__finishSelection();
  }, returnBack);
  await expect(page.getByRole('alert')).toContainText('Session changed');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1); // no reopen/replay after switching
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
  await expect(page.locator('.dv-turn-file')).toHaveCount(4, { timeout: 300 });
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.waitForTimeout(2500); await expect(page.locator('.dv-turn-file')).toHaveCount(4);
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
  await expect(frame.locator('.dv-split')).toHaveCount(2);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.bootstrap').length)).toBe(1);
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
  await expect(page.locator('.dv-turn-file').first()).toBeEnabled();
  await page.evaluate(async () => { const selection = await (window as any).pluginBridge.invoke('diff.selectTurn', { sessionId: 'session-demo', runId: 'another-run', fileId: 'created' }); await (window as any).__rendererDemo.openSelection(selection.nonce); });
  await expect(frame.locator('.dv-file[aria-current="true"]')).toContainText('src/theme/index.ts'); await expect(frame.locator('.dv-hunk')).toHaveCount(1);
  expect(await frame.locator('.dv-app').evaluate(node => node === (window as any).__originalApp)).toBe(true);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.bootstrap').length)).toBe(1);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.review').at(-1).args.runId)).toBe('another-run');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1);
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

for (const [width, count, base] of [[900, 17, 'light'], [360, 65, 'dark']] as const) test(`host fold keeps header fixed and expands all ${count} files at ${width}px / ${base}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 650 });
  await page.addInitScript(({ count }) => {
    let bridge: any, full: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value; const invoke = value.invoke.bind(value);
      value.invoke = async (method: string, args: any, internal: boolean) => {
        if (method === 'diff.turnSummary' && full) return { ...full, offset: args.offset, files: full.files.slice(args.offset, args.offset + 40), nextOffset: args.offset + 40 < count ? args.offset + 40 : null };
        const result = await invoke(method, args, internal);
        if (method === 'diff.replyCards') for (const card of result.cards) {
          const file = card.summary.files[0]; card.run.fileCount = card.summary.fileCount = count;
          full = { ...card.summary, files: Array.from({ length: count }, (_, index) => ({ ...file, id: `file-${index}`, path: `src/file-${index + 1}.ts` })) };
          card.summary.files = full.files.slice(0, 40); card.summary.nextOffset = count > 40 ? 40 : null;
        }
        return result;
      };
    } });
  }, { count });
  await setup(page, 'zh-CN', `&persisted=true&hostFold=true&scopedStyles=true&base=${base}`, Math.min(count, 40));
  const viewport = page.locator('.pi-entry-extra-block').first().locator('.pi-entry-extra-viewport');
  const header = page.locator('.dv-turn-head');
  const directory = page.locator('.dv-turn-directory');
  expect(await viewport.evaluate(node => getComputedStyle(node).overflowY)).toBe('clip');
  expect(await header.evaluate(node => ({ position: getComputedStyle(node).position, insideDirectory: !!node.closest('.dv-turn-directory') }))).toEqual({ position: 'static', insideDirectory: false });
  expect(await directory.evaluate(node => getComputedStyle(node).overflowY)).toBe('auto');
  expect(await page.locator('[data-pi-plugin="local.diff-view"]').count()).toBeGreaterThan(0);
  const initialTop = (await header.boundingBox())!.y, initialPage = await page.evaluate(() => window.scrollY);
  expect((await directory.boundingBox())!.y).toBeGreaterThanOrEqual(initialTop + (await header.boundingBox())!.height);
  await directory.hover(); await page.mouse.wheel(0, 160);
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBe(160);
  expect((await header.boundingBox())!.y).toBe(initialTop);
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(initialPage);
  await expect(header.getByRole('button', { name: '查看变更' })).toBeVisible();
  await viewport.evaluate(node => { (node as HTMLElement).style.outlineColor = 'rgb(1, 2, 3)'; });
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBe(160);
  await viewport.evaluate(node => { (node as HTMLElement).style.maxHeight = '310px'; });
  await expect.poll(() => directory.evaluate(node => node.clientHeight)).toBeGreaterThan(200);
  expect((await header.boundingBox())!.y).toBe(initialTop);
  expect(await directory.evaluate(node => node.scrollTop)).toBe(160);
  await directory.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 300); await page.waitForTimeout(150);
  expect((await header.boundingBox())!.y).toBe(initialTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(initialPage);
  await page.screenshot({ path: info.outputPath(`collapsed-${count}-${width}-${base}.png`) });
  await expect(page.getByRole('button', { name: /再显示|收起文件/ })).toHaveCount(0);
  await page.getByRole('button', { name: '展开完整内容', exact: true }).click();
  await expect(page.locator('.dv-turn-file')).toHaveCount(count);
  expect(await viewport.evaluate(node => ({ max: getComputedStyle(node).maxHeight, overflow: getComputedStyle(node).overflowY, fits: node.scrollHeight <= node.clientHeight + 1, top: node.scrollTop }))).toEqual({ max: 'none', overflow: 'visible', fits: true, top: 0 });
  expect(await directory.evaluate(node => ({ max: getComputedStyle(node).maxHeight, overflow: getComputedStyle(node).overflowY, fits: node.scrollHeight <= node.clientHeight + 1, top: node.scrollTop }))).toEqual({ max: 'none', overflow: 'visible', fits: true, top: 0 });
  expect(await page.locator('.dv-turn-overflow').evaluate(node => node.getBoundingClientRect().height)).toBe(0);
  // A subsequent host render must not restore its expanded scroll-area cap.
  await viewport.evaluate(node => { (node as HTMLElement).style.maxHeight = '480px'; });
  await expect.poll(() => viewport.evaluate(node => getComputedStyle(node).maxHeight)).toBe('none');
  await expect(page.locator('.dv-turn-file').last()).toContainText(`file-${count}.ts`);
  await expect(page.locator('.dv-turn-foot')).toHaveCount(0);
  expect(await page.locator('#other-plugin .pi-entry-extra-viewport').evaluate(node => ({ max: getComputedStyle(node).maxHeight, overflow: getComputedStyle(node).overflowY }))).toEqual({ max: '480px', overflow: 'auto' });
  expect(await page.locator('.dv-turn-card').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`full-${count}-${width}-${base}.png`), fullPage: true });
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.dv-turn-card')!.getBoundingClientRect().top + window.scrollY + 120));
  expect(await header.evaluate(node => node.getBoundingClientRect().top)).toBeLessThan(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: '收起内容', exact: true }).click();
  expect(await viewport.evaluate(node => ({ max: getComputedStyle(node).maxHeight, overflow: getComputedStyle(node).overflowY, clipped: node.scrollHeight > node.clientHeight, top: node.scrollTop }))).toEqual({ max: '280px', overflow: 'clip', clipped: true, top: 0 });
  expect(await directory.evaluate(node => ({ overflow: getComputedStyle(node).overflowY, top: node.scrollTop }))).toEqual({ overflow: 'auto', top: 0 });
  await expect(page.locator('.dv-turn-file')).toHaveCount(count);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => header.evaluate(node => node.getBoundingClientRect().top)).toBe(initialTop);
  await directory.hover(); await page.mouse.wheel(0, 120);
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBe(120);
  expect((await header.boundingBox())!.y).toBe(initialTop);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-turn-card')).toHaveCount(0);
  expect(await viewport.evaluate(node => ({ max: (node as HTMLElement).style.maxHeight, overflow: getComputedStyle(node).overflowY, mask: (node as HTMLElement).style.getPropertyValue('mask-image'), outline: (node as HTMLElement).style.outlineColor }))).toEqual({ max: '280px', overflow: 'hidden', mask: '', outline: 'rgb(1, 2, 3)' });
});

for (const auto of [false, true]) test(`${auto ? 'automatic' : 'manual'} pagination stops on errors, retries and retains loaded files`, async ({ page }) => {
  await page.addInitScript(({ auto }) => {
    let bridge: any, summary: any, requests = 0;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value; const invoke = value.invoke.bind(value);
      value.invoke = async (method: string, args: any, internal: boolean) => {
        if (method === 'diff.turnSummary' && args.offset === 4) {
          (window as any).__demo.pageRequests = ++requests;
          if (requests === 1) { if (auto) return { ...summary, offset: 4, nextOffset: 4, files: [] }; throw new Error('page temporarily unavailable'); }
          return { ...summary, offset: 4, nextOffset: null, files: [4, 5].map(index => ({ ...summary.files[0], id: `page-${index}`, path: `src/page-${index}.ts` })) };
        }
        const result = await invoke(method, args, internal);
        if (method === 'diff.replyCards') for (const card of result.cards) { card.summary.fileCount = 6; card.summary.nextOffset = 4; summary = card.summary; }
        return result;
      };
    } });
  }, { auto });
  await setup(page, 'en', `&persisted=true${auto ? '&hostFold=true&hostLimit=210&scopedStyles=true' : ''}`);
  if (auto) await page.getByRole('button', { name: '展开完整内容', exact: true }).click();
  else await page.getByRole('button', { name: 'Load more files', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(auto ? 'Invalid file-list page' : 'page temporarily unavailable');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__demo.pageRequests)).toBe(1);
  await page.getByRole('button', { name: 'Load more files', exact: true }).click();
  await expect(page.locator('.dv-turn-file')).toHaveCount(6); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.dv-turn-foot')).toHaveCount(0);
  await page.waitForTimeout(2500); await expect(page.locator('.dv-turn-file')).toHaveCount(6);
  await expect(page.getByRole('button', { name: /Show .*more files|Collapse files/ })).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('scoped host expansion sizes a short card to its files and restores the current host limit on unmount', async ({ page }) => {
  await setup(page, 'en', '&persisted=true&hostFold=true&hostLimit=210&scopedStyles=true');
  const viewport = page.locator('.pi-entry-extra-block').first().locator('.pi-entry-extra-viewport');
  await page.getByRole('button', { name: '展开完整内容', exact: true }).click();
  await expect.poll(() => viewport.evaluate(node => getComputedStyle(node).maxHeight)).toBe('none');
  expect(await viewport.evaluate(node => ({ fits: node.scrollHeight <= node.clientHeight + 1, natural: node.clientHeight < 480 }))).toEqual({ fits: true, natural: true });
  expect(await page.locator('.dv-turn-directory').evaluate(node => ({ max: getComputedStyle(node).maxHeight, overflow: getComputedStyle(node).overflowY }))).toEqual({ max: 'none', overflow: 'visible' });
  await page.getByRole('button', { name: '收起内容', exact: true }).click();
  await viewport.evaluate(node => { (node as HTMLElement).style.maxHeight = '310px'; });
  await expect.poll(() => viewport.evaluate(node => getComputedStyle(node).maxHeight)).toBe('310px');
  // The current host value, not the initial value, must survive cleanup.
  await viewport.evaluate(node => { (node as HTMLElement).dataset.expanded = 'true'; });
  await expect.poll(() => viewport.evaluate(node => getComputedStyle(node).maxHeight)).toBe('none');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  await expect(page.locator('.dv-turn-card')).toHaveCount(0);
  expect(await viewport.evaluate(node => ({ max: (node as HTMLElement).style.maxHeight, overflow: getComputedStyle(node).overflowY }))).toEqual({ max: '310px', overflow: 'auto' });
});

test('only the directory scrolls when host limits change and short lists need no toggle', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await setup(page, 'en', '&persisted=true&hostFold=true&scopedStyles=true');
  const viewport = page.locator('.pi-entry-extra-block').first().locator('.pi-entry-extra-viewport');
  const directory = page.locator('.dv-turn-directory'), header = page.locator('.dv-turn-head');
  await expect(page.locator('.pi-entry-extra-toggle')).toBeHidden();
  expect(await directory.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await viewport.evaluate(node => { (node as HTMLElement).style.maxHeight = '180px'; });
  await expect(page.getByRole('button', { name: '展开完整内容', exact: true })).toBeVisible();
  const before = (await header.boundingBox())!.y;
  await directory.hover(); await page.mouse.wheel(0, 60);
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBe(60);
  expect((await header.boundingBox())!.y).toBe(before);
  await viewport.evaluate(node => { node.scrollTop = 100; });
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(0);
  expect((await header.boundingBox())!.y).toBe(before);
  await directory.focus(); await page.keyboard.press('Home');
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => directory.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBe(before);
  await page.setViewportSize({ width: 360, height: 650 });
  await expect.poll(() => directory.evaluate(node => node.getBoundingClientRect().bottom <= node.closest('.pi-entry-extra-viewport')!.getBoundingClientRect().bottom)).toBe(true);
  await viewport.evaluate(node => { (node as HTMLElement).style.maxHeight = '310px'; });
  await expect(page.locator('.pi-entry-extra-toggle')).toBeHidden();
  expect(await directory.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
  expect(await viewport.evaluate(node => ({ max: (node as HTMLElement).style.maxHeight, overflow: getComputedStyle(node).overflowY }))).toEqual({ max: '310px', overflow: 'hidden' });
});
test('publishes the first history page before a delayed second page returns', async ({ page }) => {
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value; const invoke = value.invoke.bind(value);
      value.invoke = async (method: string, args: any, internal: boolean) => {
        if (method === 'diff.replyCards' && args.offset) {
          (window as any).__pageWaiting = true;
          await new Promise<void>(resolve => { (window as any).__releasePage = resolve; });
        }
        return invoke(method, args, internal);
      };
    } });
  });
  await setup(page, 'en', '&historyCards=24', 4, 20);
  await expect.poll(() => page.evaluate(() => (window as any).__pageWaiting)).toBe(true);
  await expect(page.locator('.dv-turn-card')).toHaveCount(20);
  await page.evaluate(() => (window as any).__releasePage());
  await expect(page.locator('.dv-turn-card')).toHaveCount(24);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('A → B → A restores only A cards immediately while feed revalidation is failing', async ({ page }) => {
  await setup(page, 'en', '&persisted=true');
  await page.evaluate(() => { const host = (window as any).__rendererDemo; (window as any).__demo.failFeed = true; host.hideReplies(); host.switchSession('other-session'); host.showReplies('other-session'); });
  await expect(page.locator('.dv-turn-card')).toHaveCount(0);
  await page.evaluate(() => { const host = (window as any).__rendererDemo; host.hideReplies(); host.switchSession('session-demo'); host.showReplies('session-demo'); });
  await expect(page.locator('.dv-turn-file')).toHaveCount(4, { timeout: 350 });
  await expect(page.locator('.dv-turn-head')).toContainText('4 files changed');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('does not show a separate child reply change card even if its message ID has cached card data', async ({ page }) => {
  await setup(page, 'en', '&childReply=true', 4, 0);
  await page.waitForTimeout(2400);
  await expect(page.locator('.dv-turn-card, .dv-turn-file')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

for (const base of ['light', 'dark']) test(`host cards share the control scale and honor live theme tokens (${base})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 800 }); await setup(page, 'zh-CN', `&base=${base}&scopedStyles=true`);
  const card = page.locator('.dv-turn-card').first(), openButton = card.locator('.dv-turn-open');
  await expect(card).toHaveCSS('border-radius', '12px');
  await expect(openButton).toHaveCSS('border-radius', '8px');
  await expect(card.locator('.dv-turn-file').first()).toHaveCSS('border-radius', '0px');
  await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await card.evaluate(node => getComputedStyle(node).getPropertyValue('--dv-radius-popup').trim())).toBe('16px');
  await page.screenshot({ path: info.outputPath(`uniform-host-card-${base}.png`) });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ds-border-default', '#a1b2c3');
    document.documentElement.style.setProperty('--ds-text-muted', '#667788');
    document.documentElement.style.setProperty('--ds-bg-hover', '#e1e2e3');
    document.body.insertAdjacentHTML('beforeend', '<button id="unrelated-host-control">宿主原有按钮</button>');
  });
  await expect(card).toHaveCSS('border-color', 'rgb(161, 178, 195)');
  await expect(card.locator('.dv-path-directory').first()).toHaveCSS('color', 'rgb(102, 119, 136)');
  await openButton.hover(); await expect(openButton).toHaveCSS('background-color', 'rgb(225, 226, 227)');
  expect(await page.locator('#unrelated-host-control').evaluate(node => getComputedStyle(node).getPropertyValue('--dv-radius-control').trim())).toBe('');
  await openButton.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(openButton).toBeFocused(); await expect(openButton).toHaveCSS('outline-width', '2px');
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('one existing view follows session changes without host view:open or reloading', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'View changes', exact: true }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-review h2')).toBeVisible();
  await expect(page.locator('.dv-turn-file').first()).toBeEnabled();
  await frame.locator('body').evaluate(() => (window as any).__instance = 'retained');
  await page.evaluate(() => (window as any).__rendererDemo.followSession('session-other'));
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((row: any) => row.method === 'diff.review').at(-1)?.args.sessionId)).toBe('session-other');
  expect(await frame.locator('body').evaluate(() => (window as any).__instance)).toBe('retained');
  expect(await page.evaluate(() => (window as any).__rendererDemo.opens.length)).toBe(1);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('a second live view makes binding ambiguous instead of taking the last global session', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'View changes', exact: true }).click();
  const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-review h2')).toBeVisible();
  await expect(page.locator('.dv-turn-file').first()).toBeEnabled();
  await page.evaluate(async () => { await fetch('/surface-rpc', { method: 'POST', body: JSON.stringify({ role: 'view', id: 'other-view', seq: 1 }) }); });
  await expect(frame.getByRole('alert')).toContainText('多个窗口');
  await expect(frame.locator('.dv-review:visible')).toHaveCount(0);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});

test('late initial settings cannot overwrite a layout selected during fast first paint', async ({ page }) => {
  await setup(page);
  await page.route('**/sidebar-demo*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/mock.js"></script><script>const invoke=pluginBridge.invoke.bind(pluginBridge);pluginBridge.invoke=async(...args)=>{const result=await invoke(...args);if(args[0]!=="diff.bootstrap")return result;const snapshot=structuredClone(result);window.__bootHeld=true;await new Promise(resolve=>window.__releaseBoot=resolve);return snapshot};</script><link rel="stylesheet" href="/index.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/index.js"></script></body></html>' }));
  await page.locator('.dv-turn-file').first().click(); const frame = page.frameLocator('iframe');
  await expect(frame.locator('.dv-hunk')).toHaveCount(2);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__bootHeld)).toBe(true);
  await frame.locator('.dv-top .dv-menu > summary').click(); await frame.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(frame.locator('.dv-split')).toHaveCount(2);
  await frame.locator('body').evaluate(() => (window as any).__releaseBoot());
  await expect(frame.getByRole('combobox', { name: 'Scope', exact: true })).toBeEnabled();
  await expect(frame.locator('.dv-split')).toHaveCount(2);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
test('a card reveals within 100ms during slow selection, then stops loading without identity flicker', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (method: string, args: any, internal: boolean) => {
      if (method === 'diff.selectTurn') await new Promise(resolve => setTimeout(resolve, 600));
      return invoke(method, args, internal);
    };
    document.addEventListener('click', event => { if ((event.target as Element).closest('.dv-turn-file')) (window as any).__clickAt = performance.now(); }, true);
    new MutationObserver(() => { if ((window as any).__revealMs == null && document.getElementById('demo-plugin-sidebar')) (window as any).__revealMs = performance.now() - (window as any).__clickAt; }).observe(document.body, { childList: true });
  });
  await page.locator('.dv-turn-file').filter({ hasText: 'src/theme/index.ts' }).click();
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.dv-review h2')).toHaveText('src/theme/index.ts');
  await expect(page.locator('.dv-turn-open')).toBeEnabled();
  await expect(frame.locator('.dv-review')).toHaveAttribute('aria-busy', 'false');
  const reveal = await page.evaluate(() => (window as any).__revealMs); console.log(`card container reveal: ${reveal.toFixed(1)}ms`); expect(reveal).toBeLessThanOrEqual(100);
  await frame.locator('body').evaluate(() => {
    (window as any).__identityFlashes = 0;
    new MutationObserver(() => { if (document.body.textContent?.includes('缺少会话身份')) (window as any).__identityFlashes++; }).observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(() => { const pane = document.querySelector('[data-session-pane]')!; for (let i = 0; i < 10; i++) pane.setAttribute('data-visible', 'true'); });
  await page.waitForTimeout(2200);
  await expect(frame.locator('.dv-review h2')).toHaveText('src/theme/index.ts');
  expect(await frame.locator('body').evaluate(() => (window as any).__identityFlashes)).toBe(0);
  expect(await frame.locator('body').evaluate(() => (window as any).__demo.calls.filter((row: any) => row.method === 'diff.readTurnSelection').length)).toBe(1);
  await page.evaluate(() => (window as any).__rendererDemo.unload());
});
