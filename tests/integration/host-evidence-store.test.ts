import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SnapshotStore, MAX_RUNS } from '../../src/core/storage';
import { HostEvidenceStore } from '../../src/core/host-evidence-store';
import { HostEvidenceBuffer } from '../../src/core/host-evidence-buffer';
import { evidenceChunks, evidenceRevision, transcriptEvidence } from '../../src/core/host-transcript';
import { canonical } from '../../src/core/path-policy';
let temp: string, root: string, store: SnapshotStore, archive: HostEvidenceStore;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'evidence-store-'));
  root = path.join(temp, 'project'); store = new SnapshotStore(path.join(temp, 'store'));
  await store.init(); archive = new HostEvidenceStore(store.directory);
});
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
function upload(buffer: HostEvidenceBuffer, messages: unknown[], sid = 's1') {
  const text = transcriptEvidence(messages), revision = evidenceRevision(text), chunks = evidenceChunks(text);
  for (const [index, chunk] of chunks.entries()) buffer.append({ sessionId: sid, root: canonical(root), revision, index, chunk, final: index === chunks.length - 1 });
}
const rows = [
  { id: 'u', role: 'user', createdAt: 1, content: 'private-user' },
  { id: 't', role: 'tool', createdAt: 2, toolCallId: 'call|fc', toolName: 'Write', toolArgs: { path: 'a.txt', content: 'new\n' }, toolStatus: 'success' },
  { id: 'a', role: 'assistant', createdAt: 3, status: 'complete', content: 'private-reply' }
];
it('restores sanitized evidence after restart, preserving tool bytes and assistant presence', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root);
  buffer.clear(); await archive.restore(buffer, 's1', root);
  const restored = buffer.messages('s1', canonical(root)) as any[];
  expect(restored[1].blocks[0].args.content).toBe('new\n');
  expect(restored[2].blocks).toEqual([{ type: 'text' }]);
  expect(JSON.stringify(restored)).not.toMatch(/private-user|private-reply/);
  upload(buffer, []); await archive.save(buffer, 's1', root); buffer.clear();
  await archive.restore(buffer, 's1', root); expect(buffer.messages('s1', canonical(root))).toHaveLength(3);
});
it('isolates session and root identities, rejects traversal and mismatched disk identity', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root); buffer.clear();
  await archive.restore(buffer, 's2', root); await archive.restore(buffer, 's1', temp);
  expect(buffer.messages('s2', canonical(root))).toBeUndefined(); expect(buffer.messages('s1', canonical(temp))).toBeUndefined();
  await expect(archive.restore(buffer, '../escape', root)).rejects.toThrow(/identity/);
  const file = path.join(store.directory, 'evidence', (await fs.readdir(path.join(store.directory, 'evidence')))[0]);
  const record = JSON.parse(await fs.readFile(file, 'utf8')); record.sessionId = 's2'; await fs.writeFile(file, JSON.stringify(record));
  await expect(archive.restore(buffer, 's1', root)).rejects.toThrow(/mismatch/);
});
it('does not persist partial uploads and rechecks secret-path allowlists on disk reads', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root);
  buffer.append({ sessionId: 's1', root: canonical(root), revision: '2-0', index: 0, chunk: '[', final: false });
  await archive.save(buffer, 's1', root); buffer.clear(); await archive.restore(buffer, 's1', root);
  expect(buffer.messages('s1', canonical(root))).toHaveLength(3);
  const file = path.join(store.directory, 'evidence', (await fs.readdir(path.join(store.directory, 'evidence')))[0]);
  const record = JSON.parse(await fs.readFile(file, 'utf8')); record.messages = [{ ...rows[1], toolArgs: { path: '.env', content: 'credential' } }];
  await fs.writeFile(file, JSON.stringify(record)); buffer.clear(); await archive.restore(buffer, 's1', root);
  expect(JSON.stringify(buffer.messages('s1', canonical(root)))).not.toContain('credential');
});
it('fails closed on corrupt or linked evidence without replacing memory data', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root); buffer.clear();
  const file = path.join(store.directory, 'evidence', (await fs.readdir(path.join(store.directory, 'evidence')))[0]);
  await fs.writeFile(file, '{broken'); await expect(archive.restore(buffer, 's1', root)).rejects.toThrow();
  expect(buffer.messages('s1', canonical(root))).toBeUndefined();
  await fs.rm(file); await fs.writeFile(path.join(temp, 'elsewhere'), '[]'); await fs.symlink(path.join(temp, 'elsewhere'), file);
  await expect(archive.restore(buffer, 's1', root)).rejects.toThrow(/Unsafe/);
});
it('refuses oversized and full stores without deleting existing sessions', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root); buffer.clear();
  const directory = path.join(store.directory, 'evidence'), file = path.join(directory, (await fs.readdir(directory))[0]);
  await fs.truncate(file, 8 * 1024 * 1024 + 1); await expect(archive.restore(buffer, 's1', root)).rejects.toThrow(/Unsafe/);
  await fs.rm(file);
  for (let i = 0; i < MAX_RUNS; i++) await fs.writeFile(path.join(directory, `${i.toString(16).padStart(64, '0')}.json`), '{}');
  upload(buffer, rows); await expect(archive.save(buffer, 's1', root)).rejects.toThrow(/session limit/);
  expect(await fs.readdir(directory)).toHaveLength(MAX_RUNS);
});
it('clears durable evidence with plugin history', async () => {
  const buffer = new HostEvidenceBuffer(); upload(buffer, rows); await archive.save(buffer, 's1', root);
  await store.clear(); buffer.clear(); await archive.restore(buffer, 's1', root);
  expect(buffer.messages('s1', canonical(root))).toBeUndefined();
  expect(await fs.readdir(path.join(store.directory, 'evidence'))).toEqual([]);
});
