import { test, expect, type Page } from '@playwright/test';

// Real Chromium geometry against ReviewApp compiled from source by serve-e2e.mjs.
// Only the bridge is mocked; this is not native-host/backend acceptance.
const longPath = `src/${'very-long-directory/'.repeat(10)}long-a.ts`;
const currentRow = (page: Page) => page.locator('.dv-file-row:has(.dv-file[aria-current="true"])');
async function setup(page: Page, width = 1100) {
  await page.setViewportSize({ width, height: 560 });
  await page.addInitScript(({ longPath }) => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value), demo = (window as any).__demo;
      demo.version = 0; demo.snapshots = new Map();
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.review') {
          const response = await invoke(method, args, internal), version = demo.version;
          const file = (id: string, path: string) => ({ ...response.files[0], id, path, actions: [], fingerprint: `${id}-${version}`, additions: 300 + version, deletions: 2 });
          const files = [
            ...Array.from({ length: 8 }, (_, i) => file(`before-${i}`, `src/before-${i}.ts`)),
            file('long-a', longPath), file('long-b', 'src/long-b.ts'),
            ...Array.from({ length: 18 }, (_, i) => file(`after-${i}`, `src/after-${i}.ts`))
          ];
          const result = { ...response, id: `sticky-${version}`, files, run: { id: 'sticky-run', root: response.root, startedAt: 1, state: 'running', fileCount: files.length, incomplete: false } };
          demo.snapshots.set(result.id, { files, version }); demo.review = result;
          return result;
        }
        if (method === 'diff.file') {
          const snapshot = demo.snapshots.get(args.reviewId), file = snapshot.files.find((file: any) => file.id === args.fileId);
          const hunk = (id: string, start: number, texts: string[]) => ({ id, oldStart: start, newStart: start, oldLines: texts.length, newLines: texts.length, header: `@@ -${start},${texts.length} +${start},${texts.length} @@`, lines: texts.map((text, i) => ({ kind: 'context', text, oldLine: start + i, newLine: start + i })) });
          const hunks = args.fileId.startsWith('long-') ? [
            ...(snapshot.version ? [hunk('new-prefix', 1, ['inserted-prefix-1', 'inserted-prefix-2', 'inserted-prefix-3'])] : []),
            hunk('long-body', 10, Array.from({ length: 300 }, (_, i) => `${args.fileId}-row-${i} ${'wide-code '.repeat(30)}`)),
            hunk('folded-tail', 400, ['tail-first', 'tail-second'])
          ] : [hunk('small', 1, ['small-file'])];
          let cursor = 0, taken = 0;
          const page = hunks.flatMap(hunk => {
            const lines = hunk.lines.filter(() => cursor++ >= args.offset && taken < args.limit && ++taken > 0);
            return lines.length ? [{ ...hunk, lines }] : [];
          });
          const totalRows = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
          return { file, hunks: page, totalRows, offset: args.offset, nextOffset: args.offset + taken < totalRows ? args.offset + taken : null };
        }
        return invoke(method, args, internal);
      };
    } });
  }, { longPath });
  await page.goto('/review-component/?lang=en');
  await expect(page.locator('.dv-file')).toHaveCount(28);
  await page.locator('.dv-file').filter({ hasText: longPath }).click();
  // Exercise real 80-row continuation, rather than injecting all rows into the DOM.
  for (let count = 80; count < 302; count += 80) {
    await expect.poll(() => page.locator('.dv-row').count()).toBeGreaterThanOrEqual(count);
    await page.locator('.dv-workspace').evaluate(node => { node.scrollTop += node.querySelector('.dv-continuation')!.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight + 60; });
  }
  await expect(page.locator('.dv-row')).toHaveCount(302);
  await expect(page.locator('.dv-continuation')).toHaveCount(0);
}
async function scrollInside(page: Page, location: 'middle' | 'bottom' = 'middle') {
  await page.locator('.dv-workspace').evaluate((node, location) => {
    const pane = node.querySelector('.dv-review')!, bounds = node.getBoundingClientRect(), rect = pane.getBoundingClientRect();
    node.scrollTop += rect.top - bounds.top + (location === 'middle' ? rect.height / 2 : rect.height - node.clientHeight / 2);
  }, location);
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('.dv-workspace')!, header = document.querySelector('.dv-top')!;
    const row = document.querySelector('.dv-file[aria-current="true"]')!.closest('.dv-file-row')!;
    const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect();
    const button = row.querySelector('.dv-file')!, b = button.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportTop: bounds.top, viewportBottom: bounds.bottom, toolbarBottom: header.getBoundingClientRect().bottom, scroll: viewport.scrollTop,
      hit: button.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)),
      documentScroll: document.scrollingElement!.scrollTop, documentWidth: document.documentElement.scrollWidth };
  });
}
async function expectPinned(page: Page) {
  const g = await geometry(page);
  expect(g.scroll).toBeGreaterThan(300);
  expect(Math.abs(g.top - g.viewportTop)).toBeLessThanOrEqual(1);
  expect(g.top).toBeGreaterThanOrEqual(g.toolbarBottom);
  expect(g.bottom).toBeLessThan(g.viewportBottom);
  expect(g.hit).toBe(true);
  expect(g.documentScroll).toBe(0);
}

for (const width of [1100, 360]) test(`long file heading remains below toolbar at middle and bottom (${width}px)`, async ({ page }) => {
  await setup(page, width);
  for (const location of ['middle', 'bottom'] as const) { await scrollInside(page, location); await expectPinned(page); }
  await expect(currentRow(page).locator('.dv-file')).toHaveAttribute('title', `${longPath} · Modified`);
  const controls = await currentRow(page).evaluate(row => Array.from(row.querySelectorAll(':scope > button, :scope > details > summary, .dv-file-name, .dv-counts')).map(button => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
  }));
  for (const control of controls) { expect(control.width).toBeGreaterThan(20); expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(width); expect(control.hit).toBe(true); }
  expect((await geometry(page)).documentWidth).toBeLessThanOrEqual(width);
  // Opening the sticky row's menu must not switch it back to position: relative.
  const menu = currentRow(page).locator('.dv-file-menu'), menuBox = (await menu.locator('summary').boundingBox())!;
  await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
  await expect(menu).toHaveAttribute('open'); await expectPinned(page);
  const copyBox = (await menu.getByRole('button', { name: 'Copy path', exact: true }).boundingBox())!;
  expect(copyBox.y).toBeGreaterThanOrEqual((await geometry(page)).bottom);
  expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(560);
  await page.mouse.click(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2);
  await expect(page.locator('.dv-toast')).toHaveText('Path copied');
  // Additional toolbar row and host titlebar height must not require a hard-coded sticky offset.
  await page.getByRole('button', { name: 'Search file paths', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.setProperty('--pi-plugin-titlebar-height', '28px'); document.body.style.paddingTop = '28px'; });
  await expectPinned(page);
});

test('file boundary pushes the old title away, then the next expanded file takes over alone', async ({ page }) => {
  await setup(page);
  await page.locator('.dv-workspace').evaluate(node => {
    node.scrollTop += node.querySelector('.dv-review')!.getBoundingClientRect().bottom - node.getBoundingClientRect().top - 20;
  });
  const previous = currentRow(page), next = page.locator('.dv-file-row').filter({ hasText: 'src/long-b.ts' });
  const a = (await previous.boundingBox())!, b = (await next.boundingBox())!, viewport = (await page.locator('.dv-workspace').boundingBox())!;
  expect(Math.abs(b.y - viewport.y - 20)).toBeLessThanOrEqual(1);
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1);
  expect(a.y).toBeLessThan(viewport.y);
  const button = next.locator('.dv-file'), box = (await button.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.dv-review h2')).toHaveText('src/long-b.ts');
  await expect(page.locator('.dv-row')).toHaveCount(80);
  await scrollInside(page); await expectPinned(page);
  const headers = await page.locator('.dv-file-row').evaluateAll(rows => rows.filter(row => {
    const rect = row.getBoundingClientRect(), top = document.querySelector('.dv-workspace')!.getBoundingClientRect().top;
    return rect.top <= top + 1 && rect.bottom > top;
  }).map(row => row.textContent));
  expect(headers).toHaveLength(1); expect(headers[0]).toContain('src/long-b.ts');
});

for (const location of ['middle', 'bottom'] as const) test(`direct title collapse at ${location} keeps that file in place without scrolling before the click`, async ({ page }) => {
  await setup(page, location === 'bottom' ? 360 : 1100); await scrollInside(page, location); await expectPinned(page);
  const before = await geometry(page), box = (await currentRow(page).locator('.dv-file').boundingBox())!;
  // A physical pointer click (no locator auto-scroll) proves the sticky control is reachable.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.dv-review')).toBeHidden();
  await expect(currentRow(page).locator('.dv-file')).toHaveAttribute('aria-expanded', 'false');
  const after = await geometry(page);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1); expect(after.hit).toBe(true);
  expect(after.scroll).toBeLessThan(500); expect(after.scroll).toBeGreaterThan(300);
  await currentRow(page).locator('.dv-file').click();
  await expect(page.locator('.dv-row')).toHaveCount(302);
  expect(Math.abs((await geometry(page)).top - after.top)).toBeLessThanOrEqual(1);
});

test('toolbar collapse also preserves the selected file instead of clamping to unrelated trailing files', async ({ page }) => {
  await setup(page); await scrollInside(page, 'bottom');
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await expect(page.locator('.dv-review')).toBeHidden();
  const after = await geometry(page);
  expect(Math.abs(after.top - after.viewportTop)).toBeLessThanOrEqual(1); expect(after.hit).toBe(true);
});

test('live insertion preserves visible code geometry, folded hunks, layout, horizontal scroll and title nodes', async ({ page }) => {
  await setup(page);
  await page.getByTitle('Display settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Wrap lines' }).uncheck();
  await page.keyboard.press('Escape');
  await page.locator('[data-hunk-nav]').last().click();
  await scrollInside(page); await expectPinned(page);
  const before = await page.evaluate(() => {
    const viewport = document.querySelector('.dv-workspace')!, row = document.querySelector('.dv-file[aria-current="true"]')!.closest('.dv-file-row')!;
    const anchor = Array.from(document.querySelectorAll('.dv-pair')).find(node => node.getBoundingClientRect().top > row.getBoundingClientRect().bottom)!;
    const pane = document.querySelector('.dv-diff-pane')!; pane.scrollLeft = 150;
    Object.assign((window as any).__demo, { savedRow: row, savedPane: pane, savedAnchor: anchor, version: 1 });
    return { top: anchor.getBoundingClientRect().top, left: pane.scrollLeft };
  });
  await expect(currentRow(page).locator('.dv-added')).toHaveText('+301');
  await expect(page.locator('.dv-review')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-hunk-nav]').last()).toHaveAttribute('aria-expanded', 'false');
  const after = await page.evaluate(() => {
    const d = (window as any).__demo;
    return { top: d.savedAnchor.getBoundingClientRect().top, left: d.savedPane.scrollLeft, retained: d.savedRow === document.querySelector('.dv-file[aria-current="true"]')!.closest('.dv-file-row') && d.savedPane === document.querySelector('.dv-diff-pane') && d.savedAnchor.isConnected };
  });
  expect(after.retained).toBe(true); expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1); expect(after.left).toBe(before.left);
  await expect(page.locator('.dv-diff-pane')).toHaveClass(/dv-nowrap/); await expect(page.locator('.dv-split')).not.toHaveCount(0);
  await expectPinned(page);
});

test('collapsed file and its hunk folds retain title geometry across a live update', async ({ page }) => {
  await setup(page); await page.locator('[data-hunk-nav]').last().click(); await scrollInside(page);
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  const before = await geometry(page);
  await page.evaluate(() => { (window as any).__demo.version = 1; });
  await expect(currentRow(page).locator('.dv-added')).toHaveText('+301');
  await expect(page.locator('.dv-review')).toBeHidden();
  const after = await geometry(page); expect(after.top).toBe(before.top); expect(after.scroll).toBe(before.scroll); expect(after.hit).toBe(true);
  await currentRow(page).locator('.dv-file').click();
  await expect(page.locator('[data-hunk-nav]').last()).toHaveAttribute('aria-expanded', 'false');
});
