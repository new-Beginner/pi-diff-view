import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostHistoryImporter, hostHistoryRunId, type HostHistoryRun } from '../../src/core/host-history';
import { hostEvidenceMessages } from '../../src/core/host-transcript';
import { SnapshotStore } from '../../src/core/storage';
import { digest, snapshotOfText } from '../../src/core/path-policy';

let temp: string, host: string, root: string, store: SnapshotStore;
const sid = 'session-one';
const message = (id: string, role: string, blocks: any[] = [], meta: object = {}) => ({ type: 'message', id, role, blocks, meta: { status: 'complete', ...meta }, createdAt: '2026-01-01T00:00:00Z' });
const user = (id = 'user-one') => message(id, 'user', [{ type: 'text', text: 'Do not persist this private prompt' }]);
const reply = (id = 'reply-one') => message(id, 'assistant', [{ type: 'text', text: 'Private reply body' }]);
const tool = (id: string, name = 'Write', args: object = { path: 'a.txt', content: 'new\n' }, review?: object, meta?: object) => message(id, 'tool', [{ type: 'tool_call', callId: id, name, args, status: 'success', result: { isError: false, details: review ? { review } : {} } }], meta);
async function session(rows: object[], id = sid) { await fs.mkdir(path.join(host, 'sessions'), { recursive: true }); await fs.writeFile(path.join(host, 'sessions', `${id}.jsonl`), [{ type: 'session', sessionId: id, schema: 1 }, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n'); }
async function evidence(id: string, overrides: object = {}, before?: string, after?: string, sessionId = sid) {
  const dir = path.join(host, 'review-changes', sessionId, id); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId, messageId: id, path: 'a.txt', operation: 'write', beforeExists: false, afterExists: true, afterHash: digest('new\n'), state: 'active', ...overrides }));
  if (before !== undefined) await fs.writeFile(path.join(dir, 'before'), before);
  if (after !== undefined) await fs.writeFile(path.join(dir, 'after'), after);
}
const importer = () => new HostHistoryImporter(store, host);
const get = (u = 'user-one', s = sid) => store.getRun(hostHistoryRunId(s, u)) as Promise<HostHistoryRun | null>;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-history-')); host = path.join(temp, 'host'); root = path.join(temp, 'never-read-project'); store = new SnapshotStore(path.join(temp, 'store')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

describe('native host evidence importer', () => {
  it('restores hash-verified Write, stable IDs, no prose, no workspace access, and restart idempotence', async () => {
    await session([user(), tool('call-one'), reply()]); await evidence('call-one');
    const read = vi.spyOn(fs, 'readFile');
    expect((await importer().syncSession(sid, root)).imported).toBe(1);
    const run = (await get())!;
    expect(run).toMatchObject({ source: 'host-history', userMessageId: 'user-one', replyMessageId: 'reply-one', state: 'completed', incomplete: false, fileCount: 1 });
    expect(run.changes['a.txt'].after.text).toBe('new\n');
    expect(run.changes['a.txt'].capture).toMatchObject({ origin: 'workspace', absolutePath: path.join(root, 'a.txt') });
    expect(JSON.stringify(run)).not.toMatch(/Private reply|private prompt/);
    expect(read.mock.calls.every(([p]) => !String(p).startsWith(root))).toBe(true);
    expect((await importer().syncSession(sid, root)).unchanged).toBe(1);
    expect((await get())!.contentVersion).toBe(1);
  });
  it('excludes native image changes but keeps text destinations renamed from images', async () => {
    await session([user(), tool('png', 'Write', { path: 'screen.PNG', content: 'new\n' }), tool('svg', 'Edit', { path: 'logo.SVG' }), tool('text', 'Write', { path: 'notes.txt', content: 'new\n' }), tool('rename', 'Bash'), reply()]);
    await evidence('png', { path: 'screen.PNG' }); await evidence('svg', { path: 'logo.SVG' });
    await evidence('text', { path: 'notes.txt' }); await evidence('rename', { path: 'renamed.txt', oldPath: 'source.JPG' });
    const diagnostics = await importer().syncSession(sid, root), run = (await get())!;
    expect(diagnostics.events).toBe(2);
    expect(Object.keys(run.changes).sort()).toEqual(['notes.txt', 'renamed.txt']);
    expect((run.changes['renamed.txt'] as any).oldPath).toBe('source.JPG'); expect(run.fileCount).toBe(2);
  });
  it('incrementally updates one running turn and settles its final reply without timestamp guesses', async () => {
    await session([user(), tool('call-one')]); await evidence('call-one');
    await importer().syncSession(sid, root, true); expect((await get())!.state).toBe('running');
    await session([user(), tool('call-one'), tool('call-two', 'Write', { path: 'b.txt', content: 'new\n' }), reply()]);
    await evidence('call-two', { path: 'b.txt' });
    await importer().syncSession(sid, root, { running: false });
    expect((await get())!).toMatchObject({ fileCount: 2, replyMessageId: 'reply-one', state: 'completed', contentVersion: 2 });
    expect(await store.listRuns()).toHaveLength(1);
  });
  it('reconstructs structured edit hunks only with full before and matching after hash', async () => {
    const hunks = [{ header: '@@ -1,2 +1,2 @@', lines: [{ type: 'context', text: 'keep' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }];
    await session([user(), tool('edit', 'Edit', { path: 'a.txt' }, { hunks }), reply()]);
    await evidence('edit', { operation: 'edit', beforeExists: true, beforeHash: digest('keep\nold\n'), afterHash: digest('keep\nnew\n') }, 'keep\nold\n');
    await importer().syncSession(sid, root);
    expect((await get())!.changes['a.txt'].after.text).toBe('keep\nnew\n');
  });
  it('keeps unknown shell modifications, rejects arbitrary shell claims and fabricated snippet stats', async () => {
    await session([user(), tool('shell', 'Bash', { command: 'echo fake > a.txt' }), tool('claim', 'Bash', { command: 'echo changed imaginary.txt' }), reply()]);
    await evidence('shell', { beforeExists: true, beforeHash: digest('old'), afterHash: digest('unrecoverable') }, 'corrupt');
    await fs.mkdir(root); await fs.writeFile(path.join(root, 'a.txt'), 'unrecoverable');
    await importer().syncSession(sid, root);
    const run = (await get())!; expect(run.fileCount).toBe(1); expect(run.incomplete).toBe(true);
    expect(run.changes['a.txt'].before.kind).toBe('unavailable'); expect(run.changes['a.txt'].after.kind).toBe('unavailable');
    expect(run.changes['a.txt'].diffStats).toBeUndefined(); expect((run.changes['a.txt'] as any).note).toContain('不可用');
  });
  it('retains structured events after missing/corrupt metadata without trusting patch-only counts', async () => {
    await session([user(), tool('lost', 'Edit', {}, { version: 1, messageId: 'lost', path: 'a.txt', operation: 'edit', additions: 400, deletions: 300, hunks: [] }), reply()]);
    await evidence('lost'); await fs.writeFile(path.join(host, 'review-changes', sid, 'lost', 'meta.json'), '{broken');
    const d = await importer().syncSession(sid, root);
    expect(d.warnings.length).toBeGreaterThan(0); const c = (await get())!.changes['a.txt'];
    expect(c.before.kind).toBe('unavailable'); expect(c.after.kind).toBe('unavailable'); expect(c.diffStats).toBeUndefined();
  });
  it('imports deletions and explicit rename metadata, and marks stopped tool-only turns incomplete', async () => {
    await session([user(), tool('delete', 'Bash'), tool('rename', 'Bash')]);
    await evidence('delete', { path: 'gone.txt', operation: 'delete', beforeExists: true, beforeHash: digest('old'), afterExists: false, afterHash: undefined }, 'old');
    await evidence('rename', { path: 'renamed.txt', oldPath: 'original.txt', operation: 'rename', beforeExists: true, beforeHash: digest('old'), afterHash: digest('new') }, 'old', 'new');
    await importer().syncSession(sid, root);
    const run = (await get())!; expect(run.state).toBe('incomplete'); expect(run.replyMessageId).toBeUndefined();
    expect(run.changes['gone.txt'].after.exists).toBe(false); expect((run.changes['renamed.txt'] as any).oldPath).toBe('original.txt');
  });
  it('groups explicit late child events under their parent turn, isolates sessions, never merges by time', async () => {
    await session([user(), tool('one'), reply(), user('user-two'), tool('child', 'Write', { path: 'child.txt', content: 'new\n' }, undefined, { parentMessageId: 'one' }), tool('two', 'Write', { path: 'two.txt', content: 'new\n' }), reply('reply-two')]);
    await evidence('one'); await evidence('child', { path: 'child.txt' }); await evidence('two', { path: 'two.txt' });
    await session([user(), tool('other'), reply()], 'session-two'); await evidence('other', {}, undefined, undefined, 'session-two');
    await importer().syncSession(sid, root); await importer().syncSession('session-two', root);
    expect(Object.keys((await get())!.changes)).toEqual(['a.txt', 'child.txt']);
    expect((await get('user-two'))!.replyMessageId).toBe('reply-two');
    expect((await get('user-one', 'session-two'))!.id).not.toBe((await get())!.id);
  });
  it('merges native reply identity into matching agent captures without duplicating turns', async () => {
    await session([user(), tool('one'), reply()]); await evidence('one'); await importer().syncSession(sid, root);
    const run = (await get())!; await store.writeRun({ ...run, id: 'agent-existing', source: undefined, replyMessageId: undefined } as HostHistoryRun);
    await fs.rm(path.join(store.directory, 'runs', `${run.id}.json`));
    const d = await importer().syncSession(sid, root); expect(d.imported).toBe(1); expect(await get()).toBeNull();
    expect((await store.getRun('agent-existing'))?.replyMessageId).toBe('reply-one');
    expect((await importer().syncSession(sid, root)).unchanged).toBe(1);
    expect(await store.listRuns()).toHaveLength(1);
  });
  it('rejects session traversal, header mismatch, secret paths and symlinked evidence', async () => {
    await expect(importer().syncSession('../escape', root)).rejects.toThrow();
    await session([user(), tool('secret'), reply()]); await evidence('secret', { path: '.env' });
    expect((await importer().syncSession(sid, root)).events).toBe(0);
    await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), JSON.stringify({ type: 'session', sessionId: 'other' }));
    expect((await importer().syncSession(sid, root)).warnings).toContain('Session header mismatch');
    const other = path.join(temp, 'other-sessions'); await fs.rename(path.join(host, 'sessions'), other);
    await fs.symlink(other, path.join(host, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await importer().syncSession(sid, root)).warnings).toContain('Session evidence unavailable or unsafe');
  });
  it('does not overwrite recovered evidence when JSONL is truncated or a session is missing', async () => {
    await session([user(), tool('one'), reply()]); await evidence('one'); await importer().syncSession(sid, root);
    await fs.appendFile(path.join(host, 'sessions', `${sid}.jsonl`), '{partial');
    expect((await importer().syncSession(sid, root)).imported).toBe(0); expect((await get())!.contentVersion).toBe(1);
    expect((await importer().syncSession('missing', root)).warnings).toHaveLength(1);
  });
  it('passes net-zero events to storage instead of filtering them', async () => {
    await session([user(), tool('zero', 'Bash'), reply()]); await evidence('zero', { beforeExists: true, beforeHash: digest('new\n') }, 'new\n', 'new\n');
    const write = vi.spyOn(store, 'writeRun'); await importer().syncSession(sid, root);
    expect(write).toHaveBeenCalledOnce(); expect(write.mock.calls[0][0].fileCount).toBe(1);
    expect(Object.keys(write.mock.calls[0][0].changes)).toEqual(['a.txt']);
  });
  it('honors explicit user-turn IDs and keeps update records in original message order', async () => {
    const final = message('explicit-final', 'assistant', [{ type: 'text', text: 'not retained' }], { userMessageId: 'user-one' });
    await session([user(), tool('one'), final, user('user-two'), tool('one', 'Write', { path: 'a.txt', content: 'new\n' }, undefined, { userMessageId: 'user-one' })]);
    await evidence('one'); await importer().syncSession(sid, root);
    expect((await get())!.replyMessageId).toBe('explicit-final'); expect(await get('user-two')).toBeNull();
  });
  it('rejects wrong Write hashes and failed tool content, deduplicates review plus metadata', async () => {
    const review = { version: 1, messageId: 'one', path: 'a.txt', operation: 'write', status: 'added' };
    const failed = tool('failed', 'Write', { path: 'failed.txt', content: 'new\n' }); failed.blocks[0].status = 'error';
    await session([user(), tool('one', 'Write', { path: 'a.txt', content: 'WRONG' }, review), failed, reply()]);
    await evidence('one'); await evidence('failed', { path: 'failed.txt' });
    expect((await importer().syncSession(sid, root)).events).toBe(2);
    expect((await get())!.changes['a.txt'].after.kind).toBe('unavailable');
    expect((await get())!.changes['failed.txt'].after.kind).toBe('unavailable');
  });
  it('isolates foreign metadata and refuses snapshot directory junctions', async () => {
    await session([user(), tool('foreign'), tool('linked', 'Bash'), reply()]);
    await evidence('foreign', { sessionId: 'different-session' });
    await evidence('linked', { beforeExists: true, beforeHash: digest('old') }, 'old', 'new\n');
    const dir = path.join(host, 'review-changes', sid, 'linked'), elsewhere = path.join(temp, 'elsewhere');
    await fs.rename(dir, elsewhere); await fs.symlink(elsewhere, dir, process.platform === 'win32' ? 'junction' : 'dir');
    const d = await importer().syncSession(sid, root); expect(d.events).toBe(0); expect(await get()).toBeNull();
  });
  it.each(['keep\r\nnew\r\n', 'keep\nnew\n', 'keep\r\nnew'])('recovers native CRLF hunks only when exact after bytes hash to %j', async after => {
    const before = 'keep\r\nold\r\n';
    const hunks = [{ header: '@@ -1,2 +1,2 @@', lines: [{ type: 'context', text: 'keep' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }];
    await session([user(), tool('crlf', 'Edit', { path: 'a.txt', ops: 'PUT 2.=2:\n+new' }, { version: 1, messageId: 'crlf', path: 'a.txt', hunks }), reply()]);
    await evidence('crlf', { beforeExists: true, beforeHash: digest(before), afterHash: digest(after) }, before);
    await importer().syncSession(sid, root);
    expect((await get())!.changes['a.txt']).toMatchObject({ before: { text: before }, after: { text: after, hash: digest(after) } });
  });
  it('recovers native empty-file Edit insertion and final-newline evidence without inventing content', async () => {
    const hunks = [{ header: '@@ -1,0 +1,1 @@', lines: [{ type: 'add', text: 'new' }, { type: 'notice', text: '\\ No newline at end of file' }] }];
    await session([user(), tool('empty-edit', 'Edit', { path: 'a.txt' }, { hunks }), reply()]);
    await evidence('empty-edit', { beforeExists: true, beforeHash: digest(''), afterHash: digest('new') }, '');
    await importer().syncSession(sid, root); expect((await get())!.changes['a.txt'].after.text).toBe('new');
  });
  it('unlocks missing before and after sides using only same-session hash-verified historical content', async () => {
    const hunks = [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }];
    await session([user(), tool('edit-first', 'Edit', { path: 'a.txt' }, { hunks }), reply(), user('user-two'), tool('write-later', 'Write', { path: 'b.txt', content: 'old\n' }), reply('reply-two')]);
    await evidence('edit-first', { beforeExists: true, beforeHash: digest('old\n'), afterHash: digest('new\n') });
    await evidence('write-later', { path: 'b.txt', afterHash: digest('old\n') });
    await importer().syncSession(sid, root);
    expect((await get())!.changes['a.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' } });
    expect(Object.keys((await get())!.changes)).toEqual(['a.txt']);
  });
  it('rejects corrupt before/after hashes and malformed CRLF hunks even when disk matches the alleged result', async () => {
    const hunks = [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', text: 'WRONG' }, { type: 'add', text: 'new' }] }];
    await session([user(), tool('bad-before', 'Bash'), tool('bad-after', 'Bash'), tool('bad-hunk', 'Edit', { path: 'c.txt' }, { hunks }), reply()]);
    await evidence('bad-before', { beforeExists: true, beforeHash: digest('old'), afterHash: digest('new') }, 'corrupt', 'new');
    await evidence('bad-after', { path: 'b.txt', afterHash: digest('different-new') }, undefined, 'corrupt');
    await evidence('bad-hunk', { path: 'c.txt', beforeExists: true, beforeHash: digest('old\r\n'), afterHash: digest('new\r\n') }, 'old\r\n');
    await fs.mkdir(root); await fs.writeFile(path.join(root, 'c.txt'), 'new\r\n');
    await importer().syncSession(sid, root);
    const changes = (await get())!.changes;
    expect(changes['a.txt'].before.kind).toBe('unavailable'); expect(changes['b.txt'].after.kind).toBe('unavailable'); expect(changes['c.txt'].after.kind).toBe('unavailable');
  });
  it('uses native live DTOs when JSONL has no tools, repairs ambiguous agent history and resists stale inbox imports', async () => {
    const callId = 'call_one|fc_one';
    await session([user()]);
    await evidence('snapshot-one', { messageId: callId, beforeExists: true, beforeHash: digest('old\n') }, 'old\n');
    const rows = hostEvidenceMessages([
      { id: 'user-one', role: 'user', createdAt: '2026-01-01T00:00:00Z', content: 'SECRET PROMPT' },
      { id: 'ui-tool-one', role: 'tool', createdAt: '2026-01-01T00:00:01Z', toolCallId: callId, toolName: 'functions.Write', toolArgs: { path: 'a.txt', content: 'new\n' }, toolStatus: 'success', status: 'complete', toolResult: { details: { review: { version: 1, messageId: callId, path: 'a.txt' } } } },
      { id: 'ui-final', role: 'assistant', createdAt: '2026-01-01T00:00:02Z', content: 'SECRET REPLY', status: 'complete' }
    ]);
    await importer().syncSession(sid, root, { running: true, messages: rows });
    const recovered = (await get())!;
    const damaged = {
      ...recovered, id: 'live-agent', source: undefined, userMessageId: undefined, boundary: 'uncertain' as const, replyMessageId: undefined, contentVersion: 5,
      changes: { 'a.txt': {
        ...recovered.changes['a.txt'], ambiguous: true, evidence: [`edit:${callId}`],
        before: { ...recovered.changes['a.txt'].before, text: null, kind: 'unavailable' as const },
        after: { ...recovered.changes['a.txt'].after, text: null, kind: 'unavailable' as const }
      } }
    };
    await store.writeRun(damaged); await store.writeRun(damaged, true);
    await fs.rm(path.join(store.directory, 'runs', `${recovered.id}.json`));
    const result = await importer().syncSession(sid, root, { running: false, messages: rows });
    expect(result.warnings).not.toContain('Unlinked host modification evidence');
    let fixed = (await store.getRun('live-agent'))!;
    expect(fixed).toMatchObject({ state: 'completed', replyMessageId: 'ui-final', incomplete: false, hostRecovery: { captureVersion: 5 } });
    expect(fixed.changes['a.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' } });
    expect(fixed.changes['a.txt'].ambiguous).toBeUndefined();
    expect(JSON.stringify(fixed)).not.toMatch(/SECRET PROMPT|SECRET REPLY/);
    await store.importInbox('host-history'); fixed = (await store.getRun('live-agent'))!;
    expect(fixed.state).toBe('completed'); expect(fixed.changes['a.txt'].after.kind).toBe('text');
    await store.writeRun({ ...damaged, contentVersion: 6 }, true); await store.importInbox('host-history');
    expect((await store.getRun('live-agent'))!.state).toBe('running');
  });
  it('keeps verified historical blobs after native snapshot cleanup and incomplete transcript refresh', async () => {
    await session([user(), tool('one', 'Bash'), reply()]);
    await evidence('one', { beforeExists: true, beforeHash: digest('old\n') }, 'old\n', 'new\n');
    await importer().syncSession(sid, root);
    await fs.rm(path.join(host, 'review-changes', sid, 'one', 'before'));
    await fs.rm(path.join(host, 'review-changes', sid, 'one', 'after'));
    await session([user(), tool('one', 'Bash')]);
    await importer().syncSession(sid, root);
    const run = (await get())!;
    expect(run).toMatchObject({ state: 'completed', replyMessageId: 'reply-one', incomplete: false });
    expect(run.changes['a.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'new\n' } });
  });
});

it('native recovery cannot acknowledge and discard a newer unimported agent snapshot', async () => {
  await session([user(), tool('one', 'Edit', { path: 'a.txt' })]);
  await evidence('one', { beforeExists: true, beforeHash: digest('old\n') });
  await importer().syncSession(sid, root, { running: true });
  const native = (await get())!;
  const live = { ...native, id: 'pending-agent', source: undefined, generation: 'agent-generation', contentVersion: 1, hostRecovery: undefined };
  await store.writeRun(live);
  await fs.rm(path.join(store.directory, 'runs', `${native.id}.json`));
  await store.writeRun({ ...live, contentVersion: 2, changes: { 'a.txt': { ...live.changes['a.txt'], before: snapshotOfText('old\n'), after: snapshotOfText('new\n'), evidence: ['edit:one'] } } }, true);
  await importer().syncSession(sid, root, { running: true });
  expect((await store.getRun(live.id))!.hostRecovery?.captureVersion).toBe(1);
  await store.importInbox('agent-generation');
  expect((await store.getRun(live.id))!.changes['a.txt']).toMatchObject({ before: { kind: 'text', text: 'old\n' }, after: { kind: 'text', text: 'new\n' } });
});

it('recovers a truncated package-lock Edit from full before bytes and hashed instructions, persists it and upgrades an unknown capture', async () => {
  const before = ['{', '  "name": "fixture",', '  "version": "1.4.0",', '  "packages": {', '    "": {', '      "version": "1.4.0",', ...Array.from({ length: 2400 }, (_, i) => `      "entry-${i}": "unchanged",`), '    }', '  }', '}', ''].join('\n');
  const after = before.replaceAll('"1.4.0"', '"1.4.1"');
  const call = tool('lock-edit', 'Edit', { path: 'package-lock.json', ops: 'PUT 3.=3:\n+  "version": "1.4.1",\nPUT 6.=6:\n+      "version": "1.4.1",' }, { hunks: [], truncated: true });
  await session([user(), call, reply()]);
  await evidence('lock-edit', { path: 'package-lock.json', operation: 'edit', beforeExists: true, beforeHash: digest(before), afterHash: digest(after) }, before);
  await store.init();
  // Model the existing unknown record before the fix.
  const first = await importer().syncSession(sid, root, { messages: [hostEvidenceMessages([call]).map(m => ({ ...m, blocks: m.blocks.map(b => ({ ...b, args: { path: b.args.path } })) }))[0]] });
  expect(first.imported).toBe(1);
  expect((await get())!.changes['package-lock.json'].after.kind).toBe('unavailable');
  const unknown = (await get())!;
  const captured = { ...unknown, id: 'agent-lock-capture', source: undefined, generation: 'agent', changes: { 'package-lock.json': { ...unknown.changes['package-lock.json'], ambiguous: true, before: { ...unknown.changes['package-lock.json'].before, kind: 'unavailable' as const, text: null } } } };
  await store.writeRun(captured); await fs.rm(path.join(store.directory, 'runs', `${unknown.id}.json`));
  const read = vi.spyOn(fs, 'readFile');
  const restored = await importer().syncSession(sid, root, { messages: hostEvidenceMessages([call]) });
  expect(restored.imported).toBe(1);
  const run = (await store.getRun(captured.id))!;
  expect(run.changes['package-lock.json']).toMatchObject({ before: { kind: 'text', text: before }, after: { kind: 'text', text: after }, diffStats: { additions: 2, deletions: 2 } });
  expect(run.changes['package-lock.json'].ambiguous).toBeUndefined();
  expect(run.incomplete).toBe(false);
  expect(read.mock.calls.every(([p]) => !String(p).startsWith(root))).toBe(true);
  expect((await importer().syncSession(sid, root)).unchanged).toBe(1);
});

it.each(['hash', 'path', 'failed'])('refuses Edit replay with invalid %s evidence', async invalid => {
  const call = tool('bad-edit', 'Edit', { path: invalid === 'path' ? 'different.txt' : 'a.txt', ops: 'PUT 1.=1:\n+new' }, { hunks: [], truncated: true });
  if (invalid === 'failed') call.blocks[0].status = 'error';
  await session([user(), call, reply()]);
  await evidence('bad-edit', { beforeExists: true, beforeHash: digest('old\n'), afterHash: digest(invalid === 'hash' ? 'not-new\n' : 'new\n') }, 'old\n');
  await importer().syncSession(sid, root);
  expect((await get())!.changes['a.txt'].after.kind).toBe('unavailable');
});
