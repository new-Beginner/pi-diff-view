import { describe, it, expect } from 'vitest';
import { hostEvidenceMessages, transcriptEvidence, evidenceChunks, evidenceRevision } from '../../src/core/host-transcript';
import { HostEvidenceBuffer } from '../../src/core/host-evidence-buffer';
describe('live host evidence transport', () => {
  it('strips prose, shell commands and stdout while retaining native tool identity and structured review', () => {
    const rows = hostEvidenceMessages([
      { id: 'u', role: 'user', createdAt: 1, content: 'private-user' },
      { id: 'a', role: 'assistant', createdAt: 2, status: 'complete', content: 'private-assistant', thinking: 'private-thinking' },
      { id: 't', role: 'tool', createdAt: 3, toolCallId: 'call|fc', toolName: 'Bash', toolStatus: 'success', toolArgs: { command: 'private-command' }, toolResult: { content: 'private-output', details: { review: { version: 1, messageId: 'call|fc', path: 'a.txt' } } } }
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private-/);
    expect(rows[2].blocks[0]).toMatchObject({ callId: 'call|fc', name: 'bash', status: 'success', result: { details: { review: { path: 'a.txt' } } } });
    expect(rows[1].blocks).toEqual([{ type: 'text' }]);
  });
  it('roundtrips large Unicode evidence within escaped RPC budgets; incomplete or mismatched uploads never replace committed data', () => {
    const source = transcriptEvidence([{ id: 't', role: 'tool', createdAt: 1, toolCallId: 'call|fc', toolName: 'Write', toolArgs: { path: 'large.txt', content: '\"\\中文😀'.repeat(12000) }, toolStatus: 'success' }]);
    const chunks = evidenceChunks(source), revision = evidenceRevision(source), buffer = new HostEvidenceBuffer();
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(28000);
      buffer.append({ sessionId: 's', root: '/root', revision, index, chunk, final: index === chunks.length - 1 });
      if (index < chunks.length - 1) expect(buffer.messages('s', '/root')).toBeUndefined();
    }
    expect(buffer.messages('s', '/root')).toEqual(JSON.parse(source));
    expect(buffer.messages('other', '/root')).toBeUndefined(); expect(buffer.messages('s', '/other')).toBeUndefined();
    buffer.append({ sessionId: 's', root: '/root', revision: '2-0', index: 0, chunk: '[', final: false });
    expect(() => buffer.append({ sessionId: 's', root: '/root', revision: '2-0', index: 2, chunk: ']', final: true })).toThrow(/sequence/);
    expect(buffer.messages('s', '/root')).toEqual(JSON.parse(source));
    expect(() => buffer.append({ sessionId: 's', root: '/root', revision: '2-0', index: 1, chunk: ']', final: true })).toThrow(/revision/);
    expect(buffer.messages('s', '/root')).toEqual(JSON.parse(source));
  });
  it('does not transfer credential/private file contents or review hunks', () => {
    const text = transcriptEvidence(['.env', '.ssh/id_rsa', 'node_modules/private.js', 'secret.pem'].map((path, i) => ({ id: `t-${i}`, role: 'tool', toolCallId: `c-${i}`, toolName: 'Write', toolArgs: { path, content: 'private-secret' }, toolResult: { details: { review: { path, hunks: ['private-secret'] } } } })));
    expect(text).not.toContain('private-secret'); expect(JSON.parse(text).every((r: any) => r.blocks.length === 0)).toBe(true);
  });
  it('omits image-file evidence while retaining ordinary files and non-image rename destinations', () => {
    const rows = hostEvidenceMessages([
      { id: 'png', role: 'tool', toolCallId: 'png-call', toolName: 'Write', toolArgs: { path: 'screen.PNG', content: 'pixel payload' } },
      { id: 'svg', role: 'tool', toolCallId: 'svg-call', toolName: 'Write', toolArgs: { path: 'logo.SVG', content: '<svg/>' } },
      { id: 'text', role: 'tool', toolCallId: 'text-call', toolName: 'Write', toolArgs: { path: 'notes.txt', content: 'ordinary text' } },
      { id: 'rename', role: 'tool', toolCallId: 'rename-call', toolName: 'Edit', toolArgs: { path: 'old.PNG' }, toolResult: { details: { review: { path: 'new.txt', oldPath: 'old.PNG' } } } },
    ]);
    expect(rows[0].blocks).toEqual([]); expect(rows[1].blocks).toEqual([]);
    expect(rows[2].blocks[0].args).toMatchObject({ path: 'notes.txt', content: 'ordinary text' });
    expect(rows[3].blocks[0].result.details.review.path).toBe('new.txt');
    expect(JSON.stringify(rows)).not.toContain('pixel payload');
  });
  it('keeps earlier native message evidence when the visible transcript window shrinks', () => {
    const buffer = new HostEvidenceBuffer();
    for (const rows of [[{ type: 'message', id: 'one' }, { type: 'message', id: 'two' }], [{ type: 'message', id: 'two', role: 'tool' }]]) {
      const text = JSON.stringify(rows); buffer.append({ sessionId: 's', root: '/root', revision: evidenceRevision(text), index: 0, chunk: text, final: true });
    }
    expect(buffer.messages('s', '/root')).toEqual([{ type: 'message', id: 'one' }, { type: 'message', id: 'two', role: 'tool' }]);
  });
});
it('preserves replayable Edit inputs through normalization but excludes private paths and arbitrary fields', () => {
  const rows = hostEvidenceMessages([
    { id: 'edit', role: 'tool', toolCallId: 'c1', toolName: 'Edit', toolArgs: { path: 'package-lock.json', ops: 'PUT 3.=3:\n+  "version": "1.4.1",', tag: 'ABCD', extra: 'private-extra' } },
    { id: 'legacy', role: 'tool', toolCallId: 'c2', toolName: 'Edit', toolArgs: { file_path: 'a.txt', old_string: 'old', new_string: 'new' } },
    { id: 'private', role: 'tool', toolCallId: 'c3', toolName: 'Edit', toolArgs: { path: '.env', ops: 'PUT 1.=1:\n+private-secret' } },
    { id: 'private-move', role: 'tool', toolCallId: 'c4', toolName: 'Edit', toolArgs: { path: 'a.txt', ops: 'MV .ssh/id_rsa' } },
  ]);
  expect(rows[0].blocks[0].args).toEqual({ path: 'package-lock.json', ops: 'PUT 3.=3:\n+  "version": "1.4.1",', tag: 'ABCD' });
  expect(rows[1].blocks[0].args).toEqual({ path: 'a.txt', old_string: 'old', new_string: 'new' });
  expect(rows[2].blocks).toEqual([]); expect(rows[3].blocks).toEqual([]);
  expect(hostEvidenceMessages(rows)).toEqual(rows);
  expect(JSON.stringify(rows)).not.toMatch(/private-secret|private-extra/);
});
