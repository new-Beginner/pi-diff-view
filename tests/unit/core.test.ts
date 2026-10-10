import { describe, it, expect } from 'vitest';
import { buildHunks, selectHunkText, inlineParts } from '../../src/core/diff';
import { snapshotOfText, snapshotFromBytes, assertPublicPath } from '../../src/core/path-policy';
describe('real text diffs', () => {
  it('counts exact old/new lines and contexts', () => {
    const before = Array.from({ length: 30 }, (_, i) => `${i+1}\n`).join('');
    const after = before.replace('10\n', 'ten\n').replace('25\n', 'twentyfive\n');
    const hunks = buildHunks(before, after);
    expect(hunks).toHaveLength(2); expect(hunks[0].lines.find(l => l.kind === 'del')?.oldLine).toBe(10);
    expect(hunks[0].lines.find(l => l.kind === 'add')?.newLine).toBe(10);
    expect(selectHunkText(before, after, hunks[0].id)).toBe(before.replace('10\n', 'ten\n'));
  });
  it('preserves CRLF, Unicode and no terminal newline', () => {
    const b = '你好\r\nold'; const a = '你好\r\n新';
    expect(selectHunkText(b, a, buildHunks(b, a)[0].id)).toBe(a);
    expect(buildHunks('', 'a')[0].lines.some(l => l.kind === 'notice')).toBe(true);
    expect(selectHunkText('', 'a', buildHunks('', 'a')[0].id)).toBe('a');
  });
  it('identifies inline changes and binary bytes', () => {
    expect(inlineParts('hello', 'hallo').next.some(p => p.changed)).toBe(true);
    expect(snapshotFromBytes(Buffer.from([0, 1])).kind).toBe('binary');
    expect(snapshotOfText('')).toMatchObject({ exists: true, size: 0, kind: 'text' });
  });
  it('rejects credential and traversal paths', () => {
    for (const p of ['../out', '.env.production', 'src/private.pem', '.git/config', 'a/.ssh/key']) expect(() => assertPublicPath(p)).toThrow();
    expect(() => assertPublicPath('src/中文 file.ts')).not.toThrow();
  });
});
