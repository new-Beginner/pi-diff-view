import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore, captureCheckpoint } from '../../src/core/storage';
import { HostHistoryImporter } from '../../src/core/host-history';
import { ReviewService } from '../../src/core/review-service';
import { hostEvidenceMessages } from '../../src/core/host-transcript';
import { capturedChange, unavailableText } from '../helpers/public-desktop-fixture';
import { snapshotOfText } from '../../src/core/path-policy';
import type { CaptureRun } from '../../src/core/contracts';

let temp: string, root: string, store: SnapshotStore;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'end-of-turn-'));
  root = path.join(temp, 'project'); await fs.mkdir(root);
  store = new SnapshotStore(path.join(temp, 'plugin-data')); await store.init();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

it.each(['workspace', 'external'] as const)('retains +10 -10 through final inbox import, settlement and cold repeated imports for %s captures with incomplete segments', async origin => {
  const file = origin === 'workspace' ? path.join(root, 'a.txt') : path.join(temp, 'outside.txt');
  const before = Array.from({ length: 10 }, (_, i) => `old-${i}`).join('\n') + '\n';
  const after = Array.from({ length: 10 }, (_, i) => `new-${i}`).join('\n') + '\n';
  const change = capturedChange(root, file, snapshotOfText(before), snapshotOfText(after), ['native:edit']);
  change.segments = [{ before: unavailableText(before), after: { ...unavailableText(after), hash: 'unavailable:edit:after' }, evidence: 'native:edit' }];
  const run: CaptureRun = { version: 2, id: 'capture', sessionId: 'session', userMessageId: 'user', root, generation: 'agent', boundary: 'user', startedAt: 1, endedAt: 4, state: 'completed', execution: { id: 'runner', revision: 2, state: 'settled' }, fileCount: 1, incomplete: false, replies: [], bindings: {}, changes: { [change.capture!.path]: change } };
  const raw = { ...change, evidence: ['edit:edit'], segments: undefined };
  await store.writeRun({ ...run, endedAt: undefined, state: 'running', execution: { id: 'runner', revision: 1, state: 'running' }, contentVersion: 3, hostRecovery: { captureVersion: 1, files: { [change.capture!.path]: captureCheckpoint(raw) } } });
  await store.writeRun({ ...run, userMessageId: undefined, contentVersion: 2, changes: { [change.capture!.path]: raw } }, true);
  await store.importInbox('agent');
  expect(await store.getRun('capture')).toMatchObject({ userMessageId: 'user', state: 'completed' });
  const messages = hostEvidenceMessages([
    { id: 'user', role: 'user', createdAt: 1 },
    { id: 'edit', role: 'tool', createdAt: 2, toolCallId: 'edit', toolName: 'Edit', toolStatus: 'success', toolArgs: { path: file, ops: 'PUT 1.=10:\n' + after.trimEnd().split('\n').map(line => '+' + line).join('\n') }, toolResult: { details: { review: { version: 1, path: change.capture!.path, messageId: 'edit', operation: 'edit', status: 'modified' } } } },
    { id: 'reply', role: 'assistant', createdAt: 4, status: 'complete', content: 'done' },
  ]);
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((target: any, ...args: any[]) => {
    if (String(target) === file) throw new Error('Never substitute live disk bytes for history');
    return (read as any)(target, ...args);
  }) as any);
  for (let index = 0; index < 3; index++) {
    const cold = new SnapshotStore(store.directory);
    await new HostHistoryImporter(cold).syncSession('session', root, { messages, statusKnown: true, running: false });
    const saved = (await cold.getRun('capture'))!;
    expect(saved.state).toBe('completed');
    expect(saved.changes[change.capture!.path]).toMatchObject({ before: { text: before, kind: 'text' }, after: { text: after, kind: 'text' } });
    const service = new ReviewService(cold, { workspace: async () => ({ path: root }), settings: async () => ({}), setSettings: async () => {}, appearance: async () => ({}), clipboard: async () => {}, openPanel: async () => {} }, 'test');
    expect(await service.turnSummary({ sessionId: 'session', runId: saved.id })).toMatchObject({ fileCount: 1, additions: 10, deletions: 10, unknownFileCount: 0 });
  }
});

it.each(['missing-final', 'newer-tool', 'running'] as const)('retains verified completion only without continuation evidence (%s)', async scenario => {
  const change = capturedChange(root, 'a.txt', snapshotOfText('old\n'), snapshotOfText('new\n'), ['edit:edit']);
  await store.writeRun({ version: 2, id: 'capture', sessionId: 'session', userMessageId: 'user', root, generation: 'agent', boundary: 'user', startedAt: 1, endedAt: 4, state: 'completed', execution: { id: 'runner', revision: 2, state: 'settled' }, fileCount: 1, incomplete: false, finalReply: { hash: 'a'.repeat(64), timestamp: 4 }, replies: [{ hash: 'a'.repeat(64), timestamp: 4 }], bindings: {}, changes: { 'a.txt': change } });
  const messages = hostEvidenceMessages([
    { id: 'user', role: 'user', createdAt: 1 },
    { id: 'edit', role: 'tool', createdAt: 2, toolCallId: 'edit', toolName: 'Edit', toolStatus: 'success', toolArgs: { path: 'a.txt', old_string: 'old', new_string: 'new' } },
  ]);
  if (scenario === 'newer-tool') messages.push(...hostEvidenceMessages([{ id: 'later', role: 'tool', createdAt: 5, toolCallId: 'later', toolName: 'Write', toolStatus: 'success', toolArgs: { path: 'a.txt', content: 'later\n' } }]));
  await new HostHistoryImporter(store).syncSession('session', root, { messages, statusKnown: scenario === 'running', running: scenario === 'running' });
  expect((await store.getRun('capture'))!.state).toBe(scenario === 'running' ? 'running' : scenario === 'newer-tool' ? 'unknown' : 'completed');
});
it.each(['runner', 'different-runner'])('only retains tool-verified USER ownership for the same final runner (%s)', async runner => {
  const raw = capturedChange(root, 'a.txt', snapshotOfText('old\n'), snapshotOfText('new\n'), ['edit:edit']);
  const run: CaptureRun = { version: 2, id: 'capture', sessionId: 'session', root, generation: 'agent', boundary: 'user', startedAt: 1, state: 'unknown', execution: { id: 'runner', revision: 1, state: 'running' }, fileCount: 1, incomplete: true, replies: [], bindings: {}, changes: { 'a.txt': raw } };
  const native = { ...raw, evidence: ['native:edit'], segments: [{ before: unavailableText('old\n'), after: unavailableText('new\n'), evidence: 'native:edit' }] };
  await store.writeRun({ ...run, userMessageId: 'user', contentVersion: 3, changes: { 'a.txt': native }, hostRecovery: { captureVersion: 1, files: { 'a.txt': captureCheckpoint(raw) } } });
  await store.writeRun({ ...run, contentVersion: 2, state: 'completed', endedAt: 4, execution: { id: runner, revision: 2, state: 'settled' } }, true);
  await store.importInbox('agent');
  const saved = (await store.getRun('capture'))!;
  expect(saved.userMessageId).toBe('user');
  expect(saved).toMatchObject(runner === 'runner' ? { state: 'completed', execution: { id: runner, revision: 2 } } : { state: 'unknown', execution: { id: 'runner', revision: 1 } });
});
