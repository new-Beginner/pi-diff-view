import { expect, it } from 'vitest';
import type { DiffHunk, ReviewDetail, ReviewFile } from '../../src/core/contracts';
import { appendDiffPage } from '../../src/view/useDiffDetail';
const file = { id: 'file-a', fingerprint: 'v1' } as ReviewFile;
const hunk = (id: string, texts: string[]): DiffHunk => ({ id, header: '@@ -1,3 +1,3 @@', oldStart: 1, newStart: 1, oldLines: 3, newLines: 3, lines: texts.map((text, index) => ({ kind: 'context', text, oldLine: index + 1, newLine: index + 1 })) });
const first: ReviewDetail = { file, offset: 0, totalRows: 4, nextOffset: 2, hunks: [hunk('h1', ['a', 'b'])] };
it('joins a continued hunk and retains earlier rows without mutating either page', () => {
  const second: ReviewDetail = { file, offset: 2, totalRows: 4, nextOffset: null, hunks: [hunk('h1', ['c']), hunk('h2', ['d'])] };
  const result = appendDiffPage(first, second);
  expect(result.hunks.map(item => item.lines.map(line => line.text))).toEqual([['a', 'b', 'c'], ['d']]);
  expect(result.offset).toBe(0); expect(result.nextOffset).toBeNull();
  expect(first.hunks[0].lines).toHaveLength(2); expect(second.hunks[0].lines).toHaveLength(1);
});
it('rejects skipped/repeated pages or a changed file, fingerprint or row count', () => {
  const page: ReviewDetail = { file, offset: 2, totalRows: 4, nextOffset: null, hunks: [hunk('h1', ['c', 'd'])] };
  for (const invalid of [{ ...page, offset: 0 }, { ...page, offset: 3 }, { ...page, totalRows: 5 }, { ...page, file: { ...file, id: 'other' } }, { ...page, file: { ...file, fingerprint: 'v2' } }]) expect(() => appendDiffPage(first, invalid)).toThrow(/Diff changed/);
});
