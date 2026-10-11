import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCaptureExtension } from '../../src/agent/capture';
import { ReviewService } from '../../src/core/review-service';
import { SnapshotStore, atomicJson } from '../../src/core/storage';
import { absentSnapshot, assertPublicPath, canonical, digest, readCapturedSnapshot, resolveCapturePath, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureIdentity, CaptureRun, TurnSummary } from '../../src/core/contracts';
let fixture: string, root: string, virtualRoot: string, plugin: string, locator: string, generation: string, external: string, actualExternal: string;
let store: SnapshotStore, service: ReviewService, copied: string;
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'diff-task-'));
  root = path.join(fixture, 'workspace'); plugin = path.join(fixture, 'plugin'); locator = path.join(fixture, 'locator.json');
  actualExternal = path.join(fixture, 'external');
  for (const dir of [root, plugin, actualExternal]) await fs.mkdir(dir);
  generation = randomUUID(); store = new SnapshotStore(path.join(fixture, 'data')); await store.init();
  await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: store.directory, generation, expiresAt: Date.now() + 60000 });
  copied = ''; service = new ReviewService(store, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async text => { copied = text; }, openPanel: async () => {} }, generation);
  // Virtual public workspace/external prefixes; every byte/handle remains in
  // mandated app-private scratch. Do not relax the production path policy.
  external = path.join(path.parse(root).root, `diff-view-external-${randomUUID()}`);
  virtualRoot = path.join(path.parse(root).root, `diff-view-workspace-${randomUUID()}`);
  const aliases = [[external, actualExternal], [virtualRoot, root]];
  const alias = (p: any) => typeof p === 'string' ? aliases.find(([prefix]) => canonical(p) === canonical(prefix) || canonical(p).startsWith(canonical(prefix) + path.sep)) : undefined;
  const map = (p: any) => { const entry = alias(p); return entry ? path.join(entry[1], path.relative(entry[0], p)) : p; };
  const lstat = fs.lstat.bind(fs), realpath = fs.realpath.bind(fs), open = fs.open.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((p: any, opts?: any) => lstat(map(p), opts) as any);
  vi.spyOn(fs, 'realpath').mockImplementation(async (p: any) => {
    const resolved = await realpath(map(p));
    const entry = alias(p); return entry ? path.join(entry[0], path.relative(entry[1], resolved)) : resolved;
  });
  vi.spyOn(fs, 'open').mockImplementation((p: any, flags: any, mode?: any) => open(map(p), flags, mode));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture, { recursive: true, force: true }); });
function harness(sessionId = 's') {
  const hooks: Record<string, Function> = {}, ctx = { cwd: virtualRoot, sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => {} } };
  createCaptureExtension({ pluginRoot: plugin, locator })({ on: (name, handler) => { hooks[name] = handler; } });
  return { emit: (name: string, args: any = {}) => hooks[name]?.(args, ctx) };
}
async function importRuns(): Promise<CaptureRun[]> { await store.importInbox(generation); return store.listRuns(); }
function message(text: string, timestamp = Date.now()) { return { role: 'assistant', content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }; }
function cardArgs(m: ReturnType<typeof message>, sessionId = 's') { return { sessionId, messageId: digest(m.content[0].text).slice(0, 12), content: m.content[0].text, createdAt: new Date(m.timestamp).toISOString() }; }
function identity(value: string, origin: CaptureIdentity['origin'] = 'workspace'): CaptureIdentity {
  const absolutePath = origin === 'workspace' ? path.resolve(root, value) : value, key = canonical(absolutePath);
  return { id: digest(key).slice(0, 24), identity: key, path: value, absolutePath, origin };
}
async function recorded(count = 5): Promise<CaptureRun> {
  const run: CaptureRun = { version: 2, boundary: 'user', contentVersion: 1, id: randomUUID(), generation, sessionId: 's', root, startedAt: Date.now(), endedAt: Date.now(), state: 'completed', incomplete: false, fileCount: count, changes: {}, replies: [], bindings: {} };
  for (let i = 0; i < count; i++) run.changes[`file-${i}.txt`] = { capture: identity(`file-${i}.txt`), before: snapshotOfText('old\n'), after: snapshotOfText(`new-${i}\nextra\n`) };
  run.changes['restored.txt'] = { capture: identity('restored.txt'), before: snapshotOfText('same\n'), after: snapshotOfText('same\n') };
  await store.writeRun(run); return run;
}
describe('USER-task final binding and bounded summaries', () => {
  it('never cards a running/intermediate/tool-loop reply; only the finalized last reply binds', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'one', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n'); await h.emit('tool_result', { toolCallId: 'one' });
    const intermediate = message('working'), final = message('done');
    await h.emit('message_end', { message: intermediate }); await importRuns(); expect((await service.card(cardArgs(intermediate))).run).toBeNull();
    await h.emit('turn_start');
    await h.emit('message_end', { message: { ...message('tool loop'), stopReason: 'toolUse', content: [{ type: 'toolCall' }] } });
    await h.emit('message_end', { message: final }); await importRuns(); expect((await service.card(cardArgs(final))).run).toBeNull();
    await h.emit('agent_end', { messages: [intermediate, final] }); const [run] = await importRuns();
    expect(run.replies).toHaveLength(2); expect(run.finalReply?.hash).toBe(digest('done'));
    expect((await service.card(cardArgs(intermediate))).run).toBeNull(); expect((await service.card(cardArgs(final))).run?.id).toBe(run.id);
    expect((await service.card(cardArgs(final, 'other'))).run).toBeNull();
    await h.emit('before_agent_start'); await h.emit('message_end', { message: message('second task') }); await h.emit('agent_end');
    expect(await importRuns()).toHaveLength(2);
  });
  it('binds the exact final reply suffix supplied by the real host aggregate, not progress or altered final text', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'one', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n'); await h.emit('tool_result', { toolCallId: 'one' });
    const progress = message('Working on the task'), final = message('  Done.\n\nChecks passed.\n ');
    await h.emit('message_end', { message: progress }); await h.emit('message_end', { message: final });
    await h.emit('agent_end', { messages: [progress, final] }); const [run] = await importRuns();
    const args = cardArgs(final), aggregate = `${progress.content[0].text}\n\n${final.content[0].text.trim()}`;
    expect((await service.card({ ...args, content: aggregate })).run?.id).toBe(run.id);
    expect((await service.card({ ...args, content: progress.content[0].text })).run).toBeNull();
    expect((await service.card({ ...args, content: `${aggregate}\n\nAn unrelated ending` })).run).toBeNull();
    expect((await service.card({ ...args, sessionId: 'other', content: aggregate })).run).toBeNull();
    expect((await service.card({ ...args, content: aggregate, createdAt: new Date(final.timestamp + 60000).toISOString() })).run).toBeNull();
    expect((await service.card({ ...args, content: aggregate, messageId: 'another-ui-message' })).run).toBeNull();
  });
  it.each([false, true])('keeps one USER-task through steering continuation (previous binding: %s)', async bound => {
    const h = harness(); await h.emit('before_agent_start'); await h.emit('agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'before-steer', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'before steer\n'); await h.emit('tool_result', { toolCallId: 'before-steer' });
    const first = message('First response'); await h.emit('message_end', { message: first });
    await h.emit('agent_end', { messages: [first] }); const [initial] = await importRuns();
    if (bound) expect((await service.card(cardArgs(first))).run?.id).toBe(initial.id);
    // Desktop forwards internal agent_end even when a pending steer causes agent.continue().
    // No before_agent_start is emitted for this continuation.
    await h.emit('agent_start');
    const [live] = await importRuns(); expect(live.id).toBe(initial.id); expect(live.state).toBe('running');
    expect((await service.replyCards({ sessionId: 's' })).cards).toEqual([]);
    await h.emit('message_end', { message: { role: 'user', content: 'Continue with this change', timestamp: Date.now() } });
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'after-steer', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'after steer\nextra\n'); await h.emit('tool_result', { toolCallId: 'after-steer' });
    const final = message('Steered task done'); await h.emit('message_end', { message: final });
    await h.emit('agent_end', { messages: [final] }); await h.emit('agent_settled');
    const runs = await importRuns(); expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: initial.id, boundary: 'user', state: 'completed', incomplete: false, fileCount: 1 });
    expect(runs[0].changes['a.txt'].before.exists).toBe(false); expect(runs[0].changes['a.txt'].after.text).toBe('after steer\nextra\n');
    expect((await service.card(cardArgs(first))).run).toBeNull();
    const card = await service.card(cardArgs(final)); expect(card.run?.id).toBe(initial.id); expect(card.summary?.additions).toBe(2);
    expect((await service.replyCards({ sessionId: 's' })).cards[0].messageId).toBe(cardArgs(final).messageId);
  });
  it('retains captured files when a steering continuation only produces a final response', async () => {
    const h = harness(); await h.emit('before_agent_start'); await h.emit('agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'one', input: { path: 'a.txt' } });
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n'); await h.emit('tool_result', { toolCallId: 'one' });
    const first = message('Working'); await h.emit('message_end', { message: first }); await h.emit('agent_end', { messages: [first] });
    await h.emit('agent_start'); const final = message('Done after your clarification');
    await h.emit('message_end', { message: final }); await h.emit('agent_end', { messages: [final] });
    const runs = await importRuns(); expect(runs).toHaveLength(1); expect(runs[0].finalReply?.hash).toBe(digest(final.content[0].text));
    expect((await service.card(cardArgs(final))).summary?.fileCount).toBe(1);
    await h.emit('before_agent_start'); await h.emit('agent_start'); await h.emit('message_end', { message: message('Separate task') }); await h.emit('agent_end');
    const separate = await importRuns(); expect(separate).toHaveLength(2); expect(separate[0].id).not.toBe(runs[0].id); expect(separate[0].fileCount).toBe(0);
  });
  it.each(['aborted', 'uncertain', 'last-tool', 'missing-time'])('does not invent a final binding for %s execution', async mode => {
    const h = harness(); if (mode !== 'uncertain') await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'one', input: { path: 'a.txt' } }); await fs.writeFile(path.join(root, 'a.txt'), 'one'); await h.emit('tool_result', { toolCallId: 'one' });
    const m = message('done'); await h.emit('message_end', { message: mode === 'missing-time' ? { ...m, timestamp: undefined } : m });
    if (mode === 'last-tool') await h.emit('message_end', { message: { ...m, content: [{ type: 'toolCall' }] } });
    await h.emit('agent_end', { aborted: mode === 'aborted' }); const [run] = await importRuns();
    expect(run.finalReply).toBeUndefined(); expect((await service.card(cardArgs(m))).run).toBeNull();
  });
  it('does not bind a no-tool message that ended while a supported tool result was still pending', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'pending', input: { path: 'a.txt' } });
    const m = message('not final'); await h.emit('message_end', { message: m });
    await fs.writeFile(path.join(root, 'a.txt'), 'a'); await h.emit('tool_result', { toolCallId: 'pending' }); await h.emit('agent_end');
    const [run] = await importRuns(); expect(run.finalReply).toBeUndefined(); expect((await service.card(cardArgs(m))).run).toBeNull();
  });
  it('guards reused/late tool ids across USER-task boundaries', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'old', input: { path: 'old.txt' } });
    await h.emit('before_agent_start'); await h.emit('tool_call', { toolName: 'Write', toolCallId: 'old', input: { path: 'new.txt' } });
    await fs.writeFile(path.join(root, 'old.txt'), 'late'); await h.emit('tool_result', { toolCallId: 'old' }); await h.emit('agent_end');
    const runs = await importRuns(); expect(runs).toHaveLength(2); expect(runs.every(r => r.incomplete && Object.keys(r.changes).length === 0)).toBe(true);
  });
  it('bounds pending before-snapshot memory and rejects over-limit stored file counts', async () => {
    const h = harness(); await h.emit('before_agent_start'); await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
    for (let i = 0; i < 17; i++) await h.emit('tool_call', { toolName: 'Edit', toolCallId: `pending-${i}`, input: { path: 'large.txt' } });
    const [run] = await importRuns(); expect(run.incomplete).toBe(true);
    await h.emit('session_shutdown');
    const oversized = await recorded(255); oversized.changes['extra.txt'] = { capture: identity('extra.txt'), before: absentSnapshot(), after: snapshotOfText('x') }; await expect(store.writeRun(oversized)).rejects.toThrow('256');
  });
  it('checks generation before reading a delayed result and never imports it into a new run', async () => {
    const h = harness(); await h.emit('before_agent_start'); await h.emit('tool_call', { toolName: 'Write', toolCallId: 'old', input: { path: 'old.txt' } });
    await atomicJson(locator, { version: 1, pluginRoot: plugin, dataPath: store.directory, generation: randomUUID(), expiresAt: Date.now() + 60000 });
    await fs.writeFile(path.join(root, 'old.txt'), 'late'); vi.mocked(fs.open).mockClear();
    await h.emit('tool_result', { toolCallId: 'old' }); expect(fs.open).not.toHaveBeenCalled();
    const [run] = await importRuns(); expect(run.changes).toEqual({});
  });
  it('omits net-restored paths and counts all files/lines independently of metadata pagination', async () => {
    const run = await recorded(7); await fs.writeFile(path.join(root, 'unrelated.txt'), 'must not appear');
    const args = { runId: run.id, sessionId: 's' }, first = await service.turnSummary(args);
    expect(first).toMatchObject({ fileCount: 7, additions: 14, deletions: 7, incomplete: false, offset: 0, nextOffset: 3 }); expect(first.files).toHaveLength(3);
    const second = await service.turnSummary({ ...args, offset: first.nextOffset!, limit: 1000 }); expect(second.files).toHaveLength(4); expect(second.nextOffset).toBeNull();
    const review = await service.review({ scope: 'turn', ...args }); expect([...first.files, ...second.files].map(f => f.id)).toEqual(review.files.map(f => f.id));
    expect(JSON.stringify(first)).not.toContain('restored'); expect(JSON.stringify(review)).not.toContain('unrelated');
    expect((await service.turnSummary({ ...args, offset: 999 })).files).toEqual([]);
    await expect(service.turnSummary({ ...args, sessionId: 'other' })).rejects.toThrow('session');
    await expect(service.turnSummary({ ...args, sessionId: '' })).rejects.toThrow('sessionId');
    await expect(service.turnSummary({ ...args, runId: '../oops' })).rejects.toThrow('runId');
    await expect(service.review({ scope: 'turn', runId: run.id })).rejects.toThrow('sessionId');
    expect((await service.review({ scope: 'turn', ...args, sessionId: 'other' })).files).toEqual([]);
  });
  it('enforces 100-entry and 28KiB byte limits without skipped file ids; caches by content, not bindings', async () => {
    const run = await recorded(120), args = { runId: run.id, sessionId: 's' };
    const first = await service.turnSummary({ ...args, limit: 10000 }); expect(first.files.length).toBeLessThanOrEqual(100); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(28 * 1024);
    const hydrate = vi.spyOn(store, 'hydrate'); await service.turnSummary(args); expect(hydrate).not.toHaveBeenCalled();
    run.bindings.reply = 'message'; await store.writeRun(run); await service.turnSummary(args); expect(hydrate).not.toHaveBeenCalled();
    let offset = 0; const ids: string[] = [];
    do { const page = await service.invoke('turnSummary', { ...args, offset, limit: 100 }) as TurnSummary; ids.push(...page.files.map(f => f.id)); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(28 * 1024); if (page.nextOffset === null) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset; } while (offset < 120);
    expect(new Set(ids).size).toBe(120);
    run.changes['file-0.txt'].after = snapshotOfText('changed\n'); run.contentVersion!++; await store.writeRun(run);
    expect((await service.turnSummary(args)).additions).toBe(239); expect(hydrate).toHaveBeenCalled();
  });
  it('retains v1 snapshots read-only, reports uncertainty, and never binds legacy replies', async () => {
    const run = await recorded(1); run.version = 1; delete run.boundary; delete run.contentVersion;
    for (const change of Object.values(run.changes)) delete change.capture;
    const m = message('legacy'); run.replies = [{ hash: digest('legacy'), timestamp: m.timestamp }]; await store.writeRun(run);
    const review = await service.review({ scope: 'turn', runId: run.id, sessionId: 's' }); expect(review.files[0].actions).toEqual([]); expect(review.notice).toContain('Legacy');
    const summary = await service.turnSummary({ runId: run.id, sessionId: 's' }); expect(summary).toMatchObject({ fileCount: 1, additions: 2, deletions: 1, incomplete: true }); expect(summary.notice).toContain('pre-installation');
    expect((await service.card(cardArgs(m))).run).toBeNull(); expect((await store.getRun(run.id))?.version).toBe(1);
  });
  it('tracks first-before/final-after and removes create-then-delete from cards and summaries', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'write', toolCallId: 'one', input: { file_path: 'new.txt' } }); await fs.writeFile(path.join(root, 'new.txt'), 'new'); await h.emit('tool_result', { toolCallId: 'one' });
    await h.emit('tool_call', { toolName: 'edit', toolCallId: 'two', input: { file_path: 'new.txt', ops: 'REM' } }); await fs.unlink(path.join(root, 'new.txt')); await h.emit('tool_result', { toolCallId: 'two' });
    const m = message('restored'); await h.emit('message_end', { message: m }); await h.emit('agent_end'); const [run] = await importRuns();
    expect(run.fileCount).toBe(0); expect((await service.turnSummary({ runId: run.id, sessionId: 's' })).files).toEqual([]); expect((await service.card(cardArgs(m))).run).toBeNull();
  });
});
describe('explicit external capture and safety boundaries', () => {
  it('captures ordinary external create/edit/delete/MV and exposes only stored read-only diffs/comments/copy', async () => {
    const h = harness(); await h.emit('before_agent_start'); const file = path.join(external, 'ordinary.txt'), moved = path.join(external, 'moved.txt');
    await fs.writeFile(path.join(actualExternal, 'ordinary.txt'), 'before\n');
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'edit', input: { file_path: file } }); await fs.writeFile(path.join(actualExternal, 'ordinary.txt'), 'after\n'); expect(await h.emit('tool_result', { toolCallId: 'edit', content: 'untouched' })).toBeUndefined();
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'move', input: { path: file, ops: `MV ${moved}` } }); await fs.rename(path.join(actualExternal, 'ordinary.txt'), path.join(actualExternal, 'moved.txt')); await h.emit('tool_result', { toolCallId: 'move' });
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'create', input: { path: path.join(external, 'new.txt') } }); await fs.writeFile(path.join(actualExternal, 'new.txt'), 'new\n'); await h.emit('tool_result', { toolCallId: 'create' });
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'delete', input: { path: path.join(external, 'new.txt'), ops: 'REM' } }); await fs.unlink(path.join(actualExternal, 'new.txt')); await h.emit('tool_result', { toolCallId: 'delete' });
    const m = message('external done'); await h.emit('message_end', { message: m }); await h.emit('agent_end'); const [run] = await importRuns();
    expect(run.incomplete).toBe(false); expect(run.fileCount).toBe(2); expect(run.changes[file].before.text).toBe('before\n'); expect(run.changes[file].after.exists).toBe(false);
    const args = { runId: run.id, sessionId: 's' }, summary = await service.turnSummary(args), review = await service.review({ scope: 'turn', ...args });
    expect(summary).toMatchObject({ fileCount: 2, additions: 1, deletions: 1 }); expect(review.root).toBe(virtualRoot); expect(review.files.map(f => f.id)).toEqual(summary.files.map(f => f.id));
    expect(review.files.every(f => f.origin === 'external' && f.absolutePath === f.path && f.actions.length === 0)).toBe(true);
    const current = review.files.find(f => f.path === moved)!; await fs.writeFile(path.join(actualExternal, 'moved.txt'), 'unrelated live content');
    const detail = await service.file({ reviewId: review.id, fileId: current.id }); expect(JSON.stringify(detail)).toContain('after'); expect(JSON.stringify(detail)).not.toContain('unrelated live');
    await expect(service.action({ reviewId: review.id, fileId: current.id, fingerprint: current.fingerprint, action: 'revert', confirmed: true })).rejects.toThrow('not available');
    await service.saveComment({ sessionId: 's', body: 'review external', anchor: { root: run.root, scope: 'turn', runId: run.id, path: moved, fingerprint: current.fingerprint, side: 'new', line: 1, text: 'after', excerpt: '' } });
    await service.invoke('copyPatch', { reviewId: review.id, fileId: current.id }); expect(copied).toContain('+after');
    await expect(service.file({ reviewId: review.id, fileId: path.join(external, 'unpassed.txt') })).rejects.toThrow('not in');
    await expect(service.invoke('copyPatch', { reviewId: review.id, fileId: 'unpassed' })).rejects.toThrow('validated');
    expect(await fs.readFile(path.join(actualExternal, 'moved.txt'), 'utf8')).toBe('unrelated live content');
  });
  it('does not authorize siblings or permit altered captured identities to read an arbitrary file', async () => {
    await fs.writeFile(path.join(actualExternal, 'a.txt'), 'a'); const capture = await resolveCapturePath(root, path.join(external, 'a.txt'), [], false);
    await fs.writeFile(path.join(actualExternal, 'b.txt'), 'secret sibling');
    await expect(readCapturedSnapshot(root, { ...capture, absolutePath: path.join(external, 'b.txt') }, [])).rejects.toThrow('identity');
    expect((await readCapturedSnapshot(root, capture, [])).text).toBe('a');
    const alias = await resolveCapturePath(root, path.join(external, '.', 'a.txt'), []); expect(alias.id).toBe(capture.id);
    if (process.platform === 'win32') expect((await resolveCapturePath(root, path.join(external, 'A.TXT'), [])).id).toBe(capture.id);
  });
  it('rejects credential, private, ADS, UNC/device, dependency and escaping paths before opening', async () => {
    const open = vi.mocked(fs.open); open.mockClear();
    for (const p of ['.env', '.env.local', '.ssh/config', '.aws/credentials', '.git/config', '.pi-diff-view/locators/x', '.pi-desktoooop/data/messages.db', 'node_modules/a', 'a.pem', 'a.txt:stream', '//server/share/a', '\\\\?\\C:\\a', 'C:relative', '../outside']) {
      expect(() => assertPublicPath(p)).toThrow(); await expect(resolveCapturePath(root, p, [], true)).rejects.toThrow();
    }
    for (const p of [path.join(plugin, 'main.js'), path.join(store.directory, 'blobs', 'x'), locator]) await expect(resolveCapturePath(root, p, [plugin, store.directory, locator], true)).rejects.toThrow('private');
    await expect(resolveCapturePath(path.join(external, '.pi-desktop', 'data'), 'messages.db', [], true)).rejects.toThrow('internal');
    expect(open).not.toHaveBeenCalled();
    await expect(resolveCapturePath(root, path.join(external, 'missing.txt'), [], false)).rejects.toThrow();
    expect((await resolveCapturePath(root, path.join(external, 'missing.txt'), [], true)).origin).toBe('external');
  });
  it('refuses external symlink/junction ancestors and regular-file substitutes', async () => {
    await fs.mkdir(path.join(actualExternal, 'dir'));
    await expect(resolveCapturePath(root, path.join(external, 'dir'), [])).rejects.toThrow('regular');
    await fs.symlink(path.join(actualExternal, 'dir'), path.join(actualExternal, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveCapturePath(root, path.join(external, 'link', 'a.txt'), [], true)).rejects.toThrow('Symlinks');
  });
  it('keeps external captures read-only even if their directory later becomes a workspace root', async () => {
    const run = await recorded(0), p = path.join(external, 'a.txt'); run.changes[p] = { capture: identity(p, 'external'), before: absentSnapshot(), after: snapshotOfText('a\n') }; await store.writeRun(run);
    vi.spyOn(service.host, 'workspace').mockResolvedValue({ path: root, roots: [external] });
    const review = await service.review({ scope: 'turn', runId: run.id, sessionId: 's' }); expect(review.files[0].actions).toEqual([]);
  });
  it('does not let a recorded historical project grant itself workspace restore authorization', async () => {
    const run = await recorded(1); vi.spyOn(service.host, 'workspace').mockResolvedValue(null);
    expect((await service.review({ scope: 'turn', runId: run.id, sessionId: 's' })).files[0].actions).toEqual([]);
  });
});
describe('new-file capture regressions', () => {
  it('captures new files under missing parent directories without weakening ancestor checks', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'nested', input: { path: 'new/deeper/a.ts' } });
    await fs.mkdir(path.join(root, 'new', 'deeper'), { recursive: true }); await fs.writeFile(path.join(root, 'new', 'deeper', 'a.ts'), 'new source\n'); await h.emit('tool_result', { toolCallId: 'nested' });
    const p = path.join(external, 'new', 'deeper', 'a.txt');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'external-nested', input: { path: p } });
    await fs.mkdir(path.join(actualExternal, 'new', 'deeper'), { recursive: true }); await fs.writeFile(path.join(actualExternal, 'new', 'deeper', 'a.txt'), 'new external\n'); await h.emit('tool_result', { toolCallId: 'external-nested' });
    await h.emit('message_end', { message: message('created nested files') }); await h.emit('agent_end');
    const [run] = await importRuns(); expect(run.fileCount).toBe(2); expect(run.incomplete).toBe(false);
    expect(run.changes['new/deeper/a.ts'].before.exists).toBe(false); expect(run.changes[p].before.exists).toBe(false);
    const summary = await service.turnSummary({ sessionId: 's', runId: run.id }); expect(summary).toMatchObject({ fileCount: 2, additions: 2, deletions: 0 });
    expect(summary.files.find(f => f.path === p)?.actions).toEqual([]);
  });
  it('retains prototype-like file names as own changes through capture, persistence and summaries', async () => {
    const h = harness(); await h.emit('before_agent_start');
    await h.emit('tool_call', { toolName: 'Write', toolCallId: 'proto-write', input: { path: '__proto__' } });
    await fs.writeFile(path.join(root, '__proto__'), 'one\n'); await h.emit('tool_result', { toolCallId: 'proto-write' });
    await h.emit('tool_call', { toolName: 'Edit', toolCallId: 'proto-edit', input: { path: '__proto__' } });
    await fs.writeFile(path.join(root, '__proto__'), 'two\n'); await h.emit('tool_result', { toolCallId: 'proto-edit' });
    await h.emit('message_end', { message: message('prototype filename done') }); await h.emit('agent_end');
    const [run] = await importRuns(); expect(run.fileCount).toBe(1); expect(run.incomplete).toBe(false);
    expect(Object.hasOwn(run.changes, '__proto__')).toBe(true); expect(run.changes['__proto__'].before.exists).toBe(false); expect(run.changes['__proto__'].after.text).toBe('two\n');
    const summary = await service.turnSummary({ sessionId: 's', runId: run.id }); expect(summary).toMatchObject({ fileCount: 1, additions: 1, deletions: 0 }); expect(summary.files[0].path).toBe('__proto__');
  });
});
