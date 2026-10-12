import { test, expect, type Page } from '@playwright/test';
// Real production bundle, deterministic delayed host snapshots; no native-host acceptance claim.
async function setup(page: Page) {
  await page.setViewportSize({ width: 1100, height: 520 });
  await page.addInitScript(() => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value), d = (window as any).__demo;
      d.version = 0; d.snapshots = new Map(); d.nextRun = false; d.changeHunk = false;
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.review') {
          const response = await invoke(method, args, internal);
          const version = d.version;
          const file = { ...response.files[0], fingerprint: `v${version}`, actions: [], additions: version + 1, deletions: 0 };
          const hunk = (id: string, oldStart: number, newStart: number, texts: string[]) => ({ id, oldStart, newStart, oldLines: texts.length, newLines: texts.length, header: `@@ -${oldStart},${texts.length} +${newStart},${texts.length} @@`, lines: texts.map((text, i) => ({ kind: i ? 'context' : 'add', oldLine: i ? oldStart + i : null, newLine: newStart + i, text })) });
          const hunks = [
            hunk(version && d.changeHunk ? '1:8:12' : '0:10:10', version && d.changeHunk ? 8 : 10, version && d.changeHunk ? 12 : 10, Array.from({ length: 150 }, (_, i) => i === 149 ? 'anchor-bottom' : `row-${i}`)),
            hunk(version && d.changeHunk ? '2:300:304' : '1:300:300', 300, version && d.changeHunk ? 304 : 300, ['second-anchor', 'unchanged-context'])
          ];
          if (version && d.changeHunk) hunks.unshift(hunk('0:1:1', 1, 1, ['new-hunk']));
          const runId = d.nextRun ? `run-${version}` : 'silent-run';
          const result = { ...response, id: `snapshot-${version}`, runId, run: { id: runId, sessionId: args.sessionId, root: response.root, state: 'running', startedAt: version + 1, incomplete: false, fileCount: 1 }, files: [file] };
          d.snapshots.set(result.id, { file, hunks, version }); d.review = result;
          return result;
        }
        if (method === 'diff.file') {
          const snapshot = d.snapshots.get(args.reviewId);
          if (snapshot.version) {
            d.preparing = true;
            if (d.hold) await new Promise<void>(resolve => d.release = resolve);
            await new Promise(resolve => setTimeout(resolve, args.offset ? 120 : 220));
          }
          await invoke(method, args, internal); // retain the actual bounded transport accounting
          let skip = 0, taken = 0;
          const hunks = snapshot.hunks.flatMap((h: any) => {
            const lines = h.lines.filter(() => skip++ >= args.offset && taken < args.limit && ++taken > 0);
            return lines.length ? [{ ...h, lines }] : [];
          });
          const totalRows = snapshot.hunks.reduce((sum: number, h: any) => sum + h.lines.length, 0);
          return { file: snapshot.file, hunks, totalRows, offset: args.offset, nextOffset: args.offset + taken < totalRows ? args.offset + taken : null };
        }
        return invoke(method, args, internal);
      };
    } });
  });
  await page.goto('/?scenario=panel&lang=zh-CN&piViewOpen=' + encodeURIComponent('diff-session:session-a?sessionId=session-a'));
  await expect(page.locator('.dv-hunk')).toHaveCount(1);
  await page.locator('.dv-workspace').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(page.locator('.dv-hunk')).toHaveCount(2);
  await expect(page.locator('.dv-diff-pane')).toContainText('anchor-bottom');
  await page.locator('.dv-workspace').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(page.locator('.dv-diff-pane')).toContainText('second-anchor');
}
async function watch(page: Page, retainHunks = true) {
  await page.evaluate(retainHunks => {
    const d = (window as any).__demo, pane = document.querySelector('.dv-diff-pane')!;
    d.nodes = [document.querySelector('.dv-app'), document.querySelector('.dv-workspace'), pane, ...(retainHunks ? Array.from(pane.querySelectorAll('.dv-hunk')) : [])];
    d.flicker = false; d.regressed = false;
    new MutationObserver(() => {
      if (d.nodes.some((node: HTMLElement) => !node?.isConnected || node.getClientRects().length === 0)) d.flicker = true;
      if (!pane.textContent?.includes('anchor-bottom') || !pane.textContent?.includes('second-anchor')) d.regressed = true;
    }).observe(document.querySelector('.dv-app')!, { childList: true, subtree: true, attributes: true });
    d.scroll = document.querySelector('.dv-workspace')!.scrollTop;
  }, retainHunks);
}
async function settled(page: Page, version: number) {
  await expect(page.locator('.dv-file .dv-added')).toHaveText(`+${version + 1}`);
  await expect(page.locator('.dv-review')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.dv-diff-pane')).toContainText('second-anchor');
  expect(await page.evaluate(() => (window as any).__demo.flicker)).toBe(false);
  expect(await page.evaluate(() => (window as any).__demo.regressed)).toBe(false);
}

test('text selection and keyboard focus survive silent updates to the selected file', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const code = Array.from(document.querySelectorAll('code.dv-code')).find(node => node.textContent === 'row-120')!;
    const range = document.createRange(); range.selectNodeContents(code);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const button = document.querySelector<HTMLButtonElement>('[data-hunk-nav]')!; button.focus({ preventScroll: true });
    const d = (window as any).__demo; d.focused = button;
  });
  await watch(page);
  await page.evaluate(() => { (window as any).__demo.version = 1; });
  await settled(page, 1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('row-120');
  expect(await page.evaluate(() => document.activeElement === (window as any).__demo.focused)).toBe(true);
});

test('a context change during preparation cannot publish pages from the old context', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { const d = (window as any).__demo; d.hold = true; d.version = 1; });
  await expect.poll(() => page.evaluate(() => (window as any).__demo.preparing)).toBe(true);
  await page.getByTitle('显示设置', { exact: true }).click();
  await page.getByRole('combobox', { name: '上下文', exact: true }).selectOption('20');
  await page.evaluate(() => { const d = (window as any).__demo; d.hold = false; d.release(); });
  await expect(page.locator('.dv-file .dv-added')).toHaveText('+2');
  await expect(page.locator('.dv-review')).toHaveAttribute('aria-busy', 'false');
  const contexts = await page.evaluate(() => (window as any).__demo.calls.filter((call: any) => call.method === 'diff.file' && call.args.reviewId === 'snapshot-1').map((call: any) => call.args.context));
  expect(contexts).toContain(20);
  await expect(page.getByRole('combobox', { name: '上下文', exact: true })).toHaveValue('20');
});

test('a changed selected file keeps all loaded rows and viewport through repeated updates', async ({ page }) => {
  await setup(page); await watch(page);
  for (let version = 1; version <= 3; version++) {
    await page.evaluate(version => { (window as any).__demo.version = version; }, version);
    await settled(page, version);
    expect(await page.locator('.dv-workspace').evaluate(node => node.scrollTop)).toBe(await page.evaluate(() => (window as any).__demo.scroll));
  }
});

test('new and shifted backend hunks reuse existing sections and keep folding', async ({ page }) => {
  await setup(page);
  const second = page.locator('[data-hunk-nav]').nth(1); await second.click();
  await page.evaluate(() => { const d = (window as any).__demo; d.secondNode = document.querySelectorAll('.dv-hunk')[1]; d.changeHunk = true; });
  await watch(page, true);
  // The folded second hunk has no row text; watch only for node retention here.
  await page.evaluate(() => { (window as any).__demo.regressed = false; (window as any).__demo.version = 1; });
  await expect(page.locator('.dv-hunk')).toHaveCount(3);
  await expect(page.locator('[data-hunk-nav]').nth(2)).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => { const d = (window as any).__demo; return !d.flicker && d.secondNode === document.querySelectorAll('.dv-hunk')[2]; })).toBe(true);
});

test('the next automatically followed turn is prepared without an intervening loading screen', async ({ page }) => {
  await setup(page); await watch(page, false);
  await page.evaluate(() => { const d = (window as any).__demo; d.nextRun = true; d.version = 1; });
  await settled(page, 1);
});

test('failed background preparation leaves the current complete diff and copy actions usable', async ({ page }) => {
  await setup(page); await watch(page);
  await page.evaluate(() => {
    const d = (window as any).__demo, bridge = (window as any).pluginBridge, invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (method: string, args: any, internal: boolean) => method === 'diff.file' && args.reviewId === 'snapshot-1' ? Promise.reject(new Error('background preparation failed')) : invoke(method, args, internal);
    d.version = 1;
  });
  await expect(page.getByRole('alert')).toContainText('background preparation failed');
  await expect(page.locator('.dv-file .dv-added')).toHaveText('+1');
  await expect(page.locator('.dv-diff-pane')).toContainText('second-anchor');
  expect(await page.evaluate(() => (window as any).__demo.flicker || (window as any).__demo.regressed)).toBe(false);
  await page.locator('.dv-file-menu summary').click();
  await expect(page.getByRole('button', { name: '复制路径', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '复制差异', exact: true })).toBeEnabled();
});
