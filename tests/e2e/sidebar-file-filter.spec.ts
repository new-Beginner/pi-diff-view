import { test, expect, type Page } from '@playwright/test';

// Exercise the real ReviewApp with a mocked bridge, including its paginated ingestion.
async function setup(page: Page, mode: 'paged' | 'empty' | 'live') {
  await page.addInitScript(mode => {
    let bridge: any;
    Object.defineProperty(window, 'pluginBridge', { configurable: true, get: () => bridge, set(value) {
      bridge = value;
      const invoke = value.invoke.bind(value);
      const state = (window as any).__fileFilter = { changed: false, pages: 0, reviews: 0 };
      const file = (id: string, extra = {}) => ({ id, path: `${id}.ts`, status: 'modified', kind: 'text', statsKnown: true, additions: 0, deletions: 0, fingerprint: id, actions: [], ...extra });
      const hidden = [file('zero'), file('deleted-unknown', { status: 'deleted', statsKnown: false }), file('deleted-binary', { status: 'deleted', kind: 'binary', statsKnown: false })];
      const kept = [file('review', { additions: 2, deletions: 1 }), file('deleted-known', { status: 'deleted', deletions: 3 }), file('existing-unknown', { kind: 'unavailable', statsKnown: false }), file('existing-binary', { kind: 'binary', statsKnown: false })];
      value.invoke = async (method: string, args: any = {}, internal = false) => {
        if (method === 'diff.reviewFiles') {
          state.pages++;
          return { reviewId: args.reviewId, offset: args.offset, files: [...hidden.map(f => ({ ...f, id: `page-${f.id}`, path: `page-${f.path}` })), ...kept], nextOffset: null };
        }
        const result = await invoke(method, args, internal);
        if (method === 'diff.review') {
          state.reviews++;
          result.id = `filter-${mode}-${state.changed}`;
          result.files = mode === 'empty' ? hidden : mode === 'paged' ? hidden : state.changed ? [file('review'), hidden[1], kept[1]] : [kept[0], kept[1]];
          result.nextFileOffset = mode === 'paged' ? hidden.length : null;
          result.totalFiles = mode === 'paged' ? hidden.length * 2 + kept.length : result.files.length;
          if (mode === 'live') result.run = { id: 'run-demo', sessionId: 'session-demo', root: result.root, startedAt: 1750000000000, state: 'running', fileCount: result.totalFiles, incomplete: true };
          (window as any).__demo.review = { ...result, files: [...hidden, ...kept] };
        }
        return result;
      };
    } });
  }, mode);
  await page.goto('/review-component/?session=session-demo&lang=zh-CN');
}

const rows = (page: Page) => page.locator('.dv-file');

test('hides zero totals and unknown deletions on initial and subsequent pages without hiding real changes', async ({ page }) => {
  await setup(page, 'paged');
  await expect.poll(() => page.evaluate(() => (window as any).__fileFilter.pages)).toBe(1);
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page)).toHaveText(['review.ts+2-1', 'deleted-known.ts+0-3', 'existing-unknown.ts行数未知', 'existing-binary.ts行数未知']);
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('review.ts');
  await expect(page.locator('.dv-top [aria-label="部分统计"]')).toContainText('+2-4');
});

test('shows the empty state when every file is filtered and never requests their diff', async ({ page }) => {
  await setup(page, 'empty');
  await expect.poll(() => page.evaluate(() => (window as any).__fileFilter.reviews)).toBe(1);
  await expect(page.locator('.dv-rail-empty')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__demo.calls.filter((c: any) => c.method === 'diff.file'))).toEqual([]);
});

test('refresh removes newly zeroed and unknown-deleted entries and selects a remaining real change', async ({ page }) => {
  await setup(page, 'live');
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('review.ts');
  await page.evaluate(() => { (window as any).__fileFilter.changed = true; });
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('.dv-file[aria-current="true"]')).toContainText('deleted-known.ts');
  await expect(rows(page)).not.toContainText('review.ts');
  await expect(rows(page)).not.toContainText('deleted-unknown.ts');
});
