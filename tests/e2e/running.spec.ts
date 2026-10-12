import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../../src/core/storage';
import { ReviewService } from '../../src/core/review-service';
import { ReviewNavigationStore } from '../../src/core/review-navigation';
import { JobQueue } from '../../src/core/jobs';
import { absentSnapshot, canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';
let hostScript = '', entry = '', dir: string, store: SnapshotStore, service: ReviewService, run: CaptureRun, since: number, replyAt: number;
let base: 'light' | 'dark', hold: (() => Promise<void>) | undefined;
test.beforeAll(async () => {
  hostScript = (await build({ entryPoints: ['tests/e2e/running-host.tsx'], bundle: true, format: 'iife', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0].text;
  entry = await fs.readFile('plugin/renderer/index.mjs', 'utf8');
});
test.beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-live-browser-'));
  store = new SnapshotStore(path.join(dir, 'data')); await store.init(); since = Date.now() - 1000; replyAt = Date.now(); base = 'light'; hold = undefined;
  const root = path.join(path.parse(dir).root, 'diff-live-browser-public-project');
  run = { version: 2, boundary: 'user', id: 'live-run', generation: 'generation', sessionId: 's', root, startedAt: since + 500, state: 'running', fileCount: 1, incomplete: false, changes: {}, replies: [], bindings: {} };
  await change();
  service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({ locale: 'zh-CN', base }), clipboard: async () => {}, openPanel: async () => { throw new Error('No modal'); } }, 'generation');
});
test.afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
async function change(text = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join('\n') + '\n') {
  const absolutePath = path.join(run.root, 'current.txt'), identity = canonical(absolutePath);
  run.changes = text ? { 'current.txt': { before: absentSnapshot(), after: snapshotOfText(text), capture: { id: digest(identity).slice(0, 24), identity, path: 'current.txt', absolutePath, origin: 'workspace' } } } : {};
  run.contentVersion = (run.contentVersion ?? 0) + 1; await store.writeRun(run);
}
async function setup(page: Page) {
  const navigation = new ReviewNavigationStore();
  const execute = async (method: string, args: any) => {
    if (method === 'rendererReport') return { ok: true };
    if (method === 'sessionEvidence' || method === 'sessionContext') return { ok: true }; // Contract-only mock; history recovery is covered by main integration tests.
    if (method === 'activeReviewSession') { navigation.setActiveSession(args.sessionId); return { ok: true }; }
    if (method === 'selectTurn') { const target = await service.selectTarget(args); return navigation.set({ scope: 'turn', sessionId: target.sessionId, runId: target.id, root: target.root }, args.fileId); }
    if (method === 'readTurnSelection') { if (!args.sessionId) throw new Error('Session required'); const selection = navigation.get(args.nonce, args.sessionId); if (!selection) throw new Error('Selection expired'); return selection; }
    if (method === 'runningChanges' && hold) await hold();
    return service.invoke(method, args);
  };
  const jobs = new JobQueue(execute);
  await page.route('**/live-rpc', async route => {
    try {
      const { method, args = {} } = route.request().postDataJSON();
      let result;
      if (method === 'jobStart') { const start = jobs.start(args.method, args.args); const job = await jobs.wait(start.jobId, args.waitMs ?? 0); result = job.state === 'pending' ? start : { ...start, ...job }; }
      else result = method === 'jobPoll' ? jobs.poll(args.jobId) : await execute(method, args);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result ?? null) });
    } catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: (error as any).code, message: String((error as Error).message) }) }); }
  });
  await page.route('**/live-production.mjs', route => route.fulfill({ contentType: 'text/javascript', body: entry }));
  await page.route('**/live-sidebar?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/index.css"><script>window.pluginBridge={invoke:async(channel,args)=>{const r=await fetch("/live-rpc",{method:"POST",body:JSON.stringify({method:channel.replace(/^diff\\./,""),args})});const data=await r.json();if(!r.ok)throw new Error(data.message);return data},on:()=>()=>{}};</script></head><body style="margin:0"><div id="root"></div><script type="module" src="/index.js"></script></body></html>' }));
  await page.route('**/live-host', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;background:${base === 'dark' ? '#171717' : '#fff'};color:${base === 'dark' ? '#ddd' : '#30343b'};font:14px/1.6 system-ui}#live-chat{width:min(800px,100%);padding:30px;box-sizing:border-box}.label{font-size:12px;opacity:.6}#live-reply{margin:20px 0 210px}.composer-shell{border:1px solid ${base === 'dark' ? '#444' : '#ececec'};border-radius:22px;padding:16px;box-sizing:border-box}.composer-input{min-height:46px;outline:none}.composer-controls{display:flex;justify-content:space-between;margin-top:12px}.composer-controls button{border:0;border-radius:50%;background:#3d83f6;color:white;width:30px;height:30px}#live-sidebar[hidden]{display:none}#live-sidebar{position:fixed;right:0;top:0;bottom:0;width:50%;background:#fff;border-left:1px solid #ccc}iframe{border:0;width:100%;height:100%}</style><script>window.__liveFixture=${JSON.stringify({ since, replyAt })};</script></head><body><main id="live-chat"><p class="label">模拟宿主 UI · 真实插件快照服务 · 非原生联调验收</p><p>正在修改本次任务的文件…</p><article id="live-reply"></article><div class="composer-shell"><div class="composer-input" role="textbox" contenteditable="true">已有草稿，请勿改变。</div><div class="composer-controls"><div class="composer-left">＋</div><button aria-label="停止当前任务">■</button></div></div></main><aside id="live-sidebar" hidden><iframe title="Diff view plugin"></iframe></aside></body></html>` }));
  await page.goto('/live-host'); await page.addScriptTag({ content: hostScript });
  await expect.poll(() => page.evaluate(() => (window as any).__liveHost.error || (window as any).__liveHost.loaded)).toBe(true);
}
async function stop(page: Page) { await page.evaluate(() => (window as any).__liveHost.unload()); await expect(page.locator('.dv-running-float, [data-test-slot]')).toHaveCount(0); }
for (const width of [360, 600, 1100]) for (const theme of ['light', 'dark'] as const) test(`running pill centered above its composer at ${width}px ${theme}`, async ({ page }, info) => {
  base = theme; await page.setViewportSize({ width, height: 820 }); await setup(page);
  const pill = page.locator('.dv-running-pill'); await expect(pill).toHaveCount(1); await expect(pill).toBeVisible(); await expect(pill).toHaveText('1 个文件已更改+11-0');
  const layout = async () => { const p = await pill.boundingBox(), c = await page.locator('.composer-shell').boundingBox(); expect(p).not.toBeNull(); expect(c).not.toBeNull(); expect(Math.abs(p!.x + p!.width / 2 - c!.x - c!.width / 2)).toBeLessThan(2); expect(p!.y + p!.height).toBeLessThanOrEqual(c!.y - 7); expect(p!.x).toBeGreaterThanOrEqual(0); expect(p!.x + p!.width).toBeLessThanOrEqual(width); };
  await layout(); await expect(page.getByRole('button', { name: '停止当前任务' })).toBeVisible(); await expect(page.locator('.dv-running-float')).toHaveAttribute('data-base', theme);
  expect(await pill.locator('.dv-running-add').evaluate(node => getComputedStyle(node).color)).not.toBe(await pill.locator('.dv-running-del').evaluate(node => getComputedStyle(node).color));
  await pill.focus(); expect(await pill.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  const screenshot = info.outputPath(`running-pill-${width}-${theme}.png`); await page.screenshot({ path: screenshot }); await info.attach('running-pill', { path: screenshot, contentType: 'image/png' });
  await page.locator('.composer-input').evaluate(node => (node as HTMLElement).style.minHeight = '110px'); await page.waitForTimeout(100); await layout();
  await page.locator('#live-chat').evaluate(node => (node as HTMLElement).style.width = '90%'); await page.waitForTimeout(100); await layout();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width); await expect(page.getByRole('textbox')).toHaveText('已有草稿，请勿改变。'); await stop(page);
});
test('updates real net totals, opens the exact read-only task and preserves the draft', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toContainText('+11'); await change('first\nsecond\n'); await expect(page.locator('.dv-running-pill')).toHaveText('1 个文件已更改+2-0');
  await page.locator('.dv-running-pill').click(); const frame = page.frameLocator('iframe'); await expect(frame.locator('.dv-review h2')).toHaveText('current.txt'); await expect(frame.locator('.dv-code').filter({ hasText: 'second' })).toBeVisible();
  await expect(frame.getByRole('button', { name: /撤销|重新应用|暂存/ })).toHaveCount(0); await expect(page.locator('.dv-layer, dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__liveHost.opens)).toHaveLength(1); await expect(page.getByRole('textbox')).toHaveText('已有草稿，请勿改变。'); await stop(page);
});
test('hides on complete, then shows the original reply card with no simultaneous pill', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toBeVisible(); run.state = 'completed'; run.endedAt = Date.now(); run.finalReply = { hash: digest('Done live task'), timestamp: replyAt }; run.replies = [run.finalReply]; await store.writeRun(run);
  await page.evaluate(() => (window as any).__liveHost.setRunning(false)); await expect(page.locator('.dv-running-pill')).toHaveCount(0, { timeout: 500 }); await expect(page.locator('.dv-turn-card')).toHaveCount(1);
  await page.locator('.dv-turn-file').click(); await expect(page.frameLocator('iframe').locator('.dv-review h2')).toHaveText('current.txt'); await expect(page.locator('.dv-running-pill')).toHaveCount(0); await stop(page);
});
test('stops, switches, rejects old task totals, and hides zero-net changes', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toBeVisible(); await page.evaluate(() => (window as any).__liveHost.switchSession('other')); await expect(page.locator('.dv-running-pill')).toHaveCount(0, { timeout: 500 });
  await page.evaluate(() => (window as any).__liveHost.switchSession('s')); await expect(page.locator('.dv-running-pill')).toBeVisible();
  const nextSince = Date.now(); await page.evaluate(value => (window as any).__liveHost.task('next-user', value), nextSince); await expect(page.locator('.dv-running-pill')).toHaveCount(0); await page.waitForTimeout(1400); await expect(page.locator('.dv-running-pill')).toHaveCount(0);
  run.state = 'completed'; run.endedAt = Date.now(); await store.writeRun(run); run = { ...run, id: 'next-run', startedAt: nextSince + 1, state: 'running', endedAt: undefined, changes: {}, replies: [], bindings: {} }; await change('new task\n'); await expect(page.locator('.dv-running-pill')).toHaveText('1 个文件已更改+1-0');
  await change(''); await expect(page.locator('.dv-running-pill')).toHaveCount(0); await change('again\n'); await expect(page.locator('.dv-running-pill')).toBeVisible(); run.state = 'aborted'; run.endedAt = Date.now(); await store.writeRun(run);
  await page.evaluate(() => (window as any).__liveHost.setRunning(false)); await expect(page.locator('.dv-running-pill')).toHaveCount(0, { timeout: 500 }); await stop(page);
});
test('a late query cannot resurrect the pill after switching away and back into an idle task', async ({ page }) => {
  let release!: () => void, waiting = false; hold = () => { waiting = true; return new Promise<void>(resolve => release = resolve); }; await setup(page); await expect.poll(() => waiting).toBe(true);
  await page.evaluate(() => { const host = (window as any).__liveHost; host.switchSession('other'); host.switchSession('s'); host.setRunning(false); }); hold = undefined; release(); await page.waitForTimeout(1400); await expect(page.locator('.dv-running-pill')).toHaveCount(0); await stop(page);
});
test('reload has one capsule and unloading cleans slots, timers, subscriptions and styles', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toBeVisible(); await page.evaluate(() => (window as any).__liveHost.reload()); await expect(page.locator('.dv-running-pill')).toHaveCount(1); await expect(page.locator('.dv-running-pill')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__liveHost.slots)).toEqual([{ slot: 'entryExtra' }, { slot: 'composerControl', positions: ['left'] }]); await stop(page);
  expect(await page.evaluate(() => { const host = (window as any).__liveHost; return [host.styles, host.subscriptions]; })).toEqual([0, 0]); await page.waitForTimeout(400); const calls = await page.evaluate(() => (window as any).__liveHost.calls.length); await page.waitForTimeout(2400); expect(await page.evaluate(() => (window as any).__liveHost.calls.length)).toBe(calls);
});
test('unknown binary counts are explicit instead of appearing as a complete zero total', async ({ page }) => {
  await change('binary evidence'); const captured = run.changes['current.txt'];
  captured.after = { ...captured.after, text: null, kind: 'binary' }; run.contentVersion = (run.contentVersion ?? 0) + 1; await store.writeRun(run);
  await setup(page); await expect(page.locator('.dv-running-pill')).toHaveText('1 个文件已更改行数未知');
  await expect(page.locator('.dv-running-add, .dv-running-del')).toHaveCount(0); await stop(page);
});
test('windowed transcripts retain current task identity; repeated slots produce one capsule', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toBeVisible();
  await page.evaluate(() => { const host = (window as any).__liveHost; host.windowTranscript(); host.duplicateComposer(); });
  await page.waitForTimeout(1300); await expect(page.locator('.dv-running-pill')).toHaveCount(1); await expect(page.locator('.dv-running-pill')).toBeVisible(); await stop(page);
});
test('missing composer ancestry is diagnosed and positioning recovers without changing the draft', async ({ page }) => {
  await setup(page); await expect(page.locator('.dv-running-pill')).toBeVisible();
  await page.locator('.composer-shell').evaluate(node => node.setAttribute('class', 'missing-shell'));
  await expect(page.locator('.dv-running-pill')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__liveHost.calls.some((call: any) => call.method === 'rendererReport' && call.args.stage === 'composer-anchor-missing'))).toBe(true);
  await page.locator('.missing-shell').evaluate(node => node.setAttribute('class', 'composer-shell'));
  await expect(page.locator('.dv-running-pill')).toBeVisible(); await expect(page.getByRole('textbox')).toHaveText('已有草稿，请勿改变。'); await stop(page);
});
test('final renderer uploads native live tool evidence in bounded chunks without conversational prose', async ({ page }) => {
  await setup(page);
  const createdAt = new Date(since).toISOString();
  await page.evaluate(createdAt => (window as any).__liveHost.updateEvidence([
    { id: 'current-user', role: 'user', createdAt, content: 'private-user-prose' },
    { id: 'call_one|fc_one', role: 'tool', createdAt, toolCallId: 'call_one|fc_one', toolName: 'functions.Write', toolArgs: { path: 'a.txt', content: '中文😀'.repeat(12000) }, toolStatus: 'success', status: 'complete' },
    { id: 'reply-one', role: 'assistant', createdAt, content: 'private-reply-prose', status: 'complete' }
  ]), createdAt);
  await expect.poll(() => page.evaluate(() => (window as any).__liveHost.calls.filter((c: any) => c.method === 'jobStart' && c.args.method === 'sessionEvidence').some((c: any) => c.args.args.final && c.args.args.index > 0)), { timeout: 20000 }).toBe(true);
  const uploads = await page.evaluate(() => (window as any).__liveHost.calls.filter((c: any) => c.method === 'jobStart' && c.args.method === 'sessionEvidence').map((c: any) => ({ args: c.args.args })));
  const revision = uploads.at(-1).args.revision;
  const chunks = uploads.filter((c: any) => c.args.revision === revision);
  for (const c of chunks) expect(Buffer.byteLength(JSON.stringify(c.args.chunk))).toBeLessThanOrEqual(28000);
  const evidence = chunks.map((c: any) => c.args.chunk).join('');
  expect(evidence).not.toMatch(/private-user-prose|private-reply-prose/);
  expect(JSON.parse(evidence)[1].blocks[0]).toMatchObject({ callId: 'call_one|fc_one', name: 'write', args: { path: 'a.txt' } });
  await stop(page);
});
