import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HostHistoryImporter, hostHistoryRunId } from '../../src/core/host-history';
import { SnapshotStore } from '../../src/core/storage';
import { canonical, digest, snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';
let temp: string, root: string, host: string, store: SnapshotStore;
const sid = 'repair-session', user = 'repair-user';
beforeEach(async () => { temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'turn-repair-')); host = path.join(temp, 'host'); root = path.join(temp, 'project'); store = new SnapshotStore(path.join(temp, 'store')); await store.init(); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
async function fixture() {
  const rows: any[] = [{ type: 'session', sessionId: sid }, { type: 'message', id: user, role: 'user', createdAt: 1000, blocks: [] }];
  for (const [index, text] of ['first\n', 'final\nextra\n'].entries()) {
    const id = `call-${index}`, file = path.join(root, 'a.txt'), dir = path.join(host, 'review-changes', sid, id);
    const before = index ? 'first\n' : 'old\n'; await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'before'), before); await fs.writeFile(path.join(dir, 'after'), text);
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId: sid, messageId: id, path: file, beforeExists: true, beforeHash: digest(before), afterExists: true, afterHash: digest(text) }));
    rows.push({ type: 'message', id, role: 'tool', createdAt: 1001 + index, blocks: [{ type: 'tool_call', callId: id, name: 'Write', args: { path: file, content: text }, status: 'success', result: {} }] });
  }
  rows.push({ type: 'message', id: 'final-reply', role: 'assistant', createdAt: 1004, meta: { status: 'complete' }, blocks: [{ type: 'text' }] });
  await fs.mkdir(path.join(host, 'sessions'), { recursive: true }); await fs.writeFile(path.join(host, 'sessions', `${sid}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n'));
  const oldRoot = path.join(host, 'scratch', sid), file = path.join(root, 'a.txt'), identity = canonical(file);
  const legacy: CaptureRun = { version: 2, id: hostHistoryRunId(sid, user), sessionId: sid, root: oldRoot, source: 'host-history', userMessageId: user, boundary: 'user', generation: 'host-history', startedAt: 1000, state: 'running', incomplete: false, fileCount: 1, contentVersion: 1, replies: [], bindings: { reply: 'final-reply' }, changes: { [file]: { capture: { path: file, absolutePath: file, identity, id: digest(identity).slice(0, 24), origin: 'external' }, before: snapshotOfText('old\n'), after: snapshotOfText('first\n'), evidence: ['native:call-0'] } } };
  const agent: CaptureRun = { ...legacy, id: 'agent-run', source: undefined, userMessageId: undefined, root, generation: 'agent', state: 'incomplete', contentVersion: 3, bindings: {}, changes: { 'a.txt': { ...legacy.changes[file], capture: { ...legacy.changes[file].capture!, path: 'a.txt', origin: 'workspace' }, evidence: ['write:call-0', 'write:call-1'], ambiguous: true, before: { ...snapshotOfText('old\n'), kind: 'unavailable', text: null }, after: { ...snapshotOfText('final\nextra\n'), kind: 'unavailable', text: null } } } };
  await store.writeRun(legacy); await store.writeRun(agent); return { legacy, agent };
}
it('reports a root conflict without freezing credible final status or silently migrating content', async () => {
  const { legacy } = await fixture(); const d = await new HostHistoryImporter(store, host).syncSession(sid, root);
  expect(d.warnings.join(' ')).toContain('root conflict');
  const old = (await store.getRun(legacy.id))!;
  expect(old).toMatchObject({ root: legacy.root, state: 'completed', endedAt: 1004 });
  expect(old.changes[path.join(root, 'a.txt')].after.text).toBe('first\n');
});
it('explicit verified repair merges scratch/project records, preserves old references and blocks stale inbox revival', async () => {
  const { legacy, agent } = await fixture(); const importer = new HostHistoryImporter(store, host);
  const result = await importer.syncSession(sid, root, { repairRootConflicts: true });
  expect(result.warnings).toEqual([]); expect(await store.listRuns()).toHaveLength(1);
  const fixed = (await store.getRun(agent.id))!;
  expect(fixed).toMatchObject({ root, userMessageId: user, state: 'completed', incomplete: false, fileCount: 1 });
  expect(fixed.changes['a.txt']).toMatchObject({ before: { text: 'old\n' }, after: { text: 'final\nextra\n' } });
  expect((await store.getRun(legacy.id))!.id).toBe(agent.id);
  expect((await fs.readdir(path.join(store.directory, 'backups'))).length).toBeGreaterThan(0);
  await store.writeRun(legacy, true); await store.writeRun({ ...agent, contentVersion: 4 }, true); await store.importInbox('agent');
  expect(await store.listRuns()).toHaveLength(1); expect((await store.getRun(agent.id))!.state).toBe('completed');
  expect((await importer.syncSession(sid, root, { repairRootConflicts: true })).unchanged).toBe(1);
});
it.each(['project', 'hash', 'identity'])('refuses migration for unverified %s conflicts', async reason => {
  const { legacy } = await fixture();
  if (reason === 'project') legacy.root = path.join(temp, 'other-project');
  if (reason === 'hash') legacy.changes[path.join(root, 'a.txt')].after = snapshotOfText('foreign\n');
  if (reason === 'identity') legacy.changes[path.join(root, 'a.txt')].evidence = ['native:unlinked'];
  await store.writeRun(legacy);
  const d = await new HostHistoryImporter(store, host).syncSession(sid, root, { repairRootConflicts: true });
  expect(d.warnings.join(' ')).toContain('conflict'); expect((await store.getRun(legacy.id))!.root).toBe(legacy.root);
  expect(await store.listRuns()).toHaveLength(2);
});

it('rebuilds incorrectly scratch-mapped relative identities from exact native IDs and preserves selected file IDs', async () => {
  const { legacy, agent } = await fixture(), file = path.join(root, 'a.txt'), scratchFile = path.join(legacy.root, 'a.txt'), identity = canonical(scratchFile);
  legacy.changes = { 'a.txt': { ...legacy.changes[file], capture: { path: 'a.txt', absolutePath: scratchFile, identity, id: digest(identity).slice(0, 24), origin: 'workspace' } } };
  await store.writeRun(legacy);
  await new HostHistoryImporter(store, host).syncSession(sid, root, { repairRootConflicts: true });
  expect((await store.getRun(legacy.id))!.id).toBe(agent.id);
  expect(await store.resolveFileId(legacy.id, digest(identity).slice(0, 24))).toBe(agent.changes['a.txt'].capture!.id);
});

it('keeps verified completeness after an old whole-run snapshot advances only its content version', async () => {
  const { agent } = await fixture();
  const identity = canonical(path.join(root, 'b.txt'));
  agent.changes['b.txt'] = { capture: { id: digest(identity).slice(0, 24), identity, absolutePath: path.join(root, 'b.txt'), path: 'b.txt', origin: 'workspace' }, before: snapshotOfText('before\n'), after: snapshotOfText('after\n'), evidence: ['write:call-0'] };
  agent.incomplete = true; await store.writeRun(agent);
  const importer = new HostHistoryImporter(store, host);
  await importer.syncSession(sid, root, { repairRootConflicts: true });
  expect((await store.getRun(agent.id))!).toMatchObject({ state: 'completed', incomplete: false, fileCount: 2 });
  await store.writeRun({ ...agent, contentVersion: 1000 }, true); await store.importInbox('agent');
  expect((await store.getRun(agent.id))!).toMatchObject({ state: 'completed', incomplete: false, fileCount: 2 });
  expect((await importer.syncSession(sid, root, { repairRootConflicts: true })).imported).toBe(0);
  const changed = { ...agent, contentVersion: 1001, changes: { ...agent.changes, 'b.txt': { ...agent.changes['b.txt'], after: snapshotOfText('changed\n') } } };
  await store.writeRun(changed, true); await store.importInbox('agent');
  expect((await store.getRun(agent.id))!).toMatchObject({ state: 'completed', incomplete: true });
});
