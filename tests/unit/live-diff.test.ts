import { describe, it, expect } from 'vitest';
import { reconcileHunkViews } from '../../src/view/live-diff';
import type { DiffHunk } from '../../src/core/contracts';
const hunk = (id: string, start: number, length = 3): DiffHunk => ({ id, header: id, oldStart: start, oldLines: length, newStart: start, newLines: length, lines: [{ kind: 'context', oldLine: start, newLine: start, text: 'unchanged' }] });
const counter = () => { let i = 0; return () => `view-${i++}`; };
describe('live hunk identity', () => {
  it('retains unchanged objects and row arrays while backend IDs change', () => {
    const key = counter(), before = reconcileHunkViews([], [hunk('0', 10)], key);
    expect(reconcileHunkViews(before, [hunk('0', 10)], key)[0]).toBe(before[0]);
    const next = reconcileHunkViews(before, [hunk('1', 10)], key)[0];
    expect(next.key).toBe(before[0].key); expect(next.hunk.id).toBe('1'); expect(next.hunk.lines).toBe(before[0].hunk.lines);
  });
  it('inserts earlier hunks without stealing exact keys from existing blocks', () => {
    const key = counter(), before = reconcileHunkViews([], [hunk('0:10', 10), hunk('1:30', 30)], key);
    const next = reconcileHunkViews(before, [hunk('0:1', 1), hunk('1:8', 8, 6), hunk('2:30', 30)], key);
    expect(next.map(view => view.key)).toEqual(['view-2', 'view-0', 'view-1']);
  });
  it('splits and merges blocks without ever assigning duplicate keys', () => {
    const key = counter(), before = reconcileHunkViews([], [hunk('0', 10, 20)], key);
    const split = reconcileHunkViews(before, [hunk('0a', 10, 4), hunk('0b', 20, 4)], key);
    expect(split.map(view => view.key)).toEqual(['view-0', 'view-1']);
    const merged = reconcileHunkViews(split, [hunk('merged', 8, 20)], key);
    expect(merged[0].key).toBe('view-0'); expect(merged[0].hunk.id).toBe('merged');
  });
  it('does not reuse removed blocks for unrelated content or leak the old backend hunk', () => {
    const key = counter(), before = reconcileHunkViews([], [hunk('old', 10)], key);
    const next = reconcileHunkViews(before, [hunk('new', 50)], key);
    expect(next[0].key).not.toBe(before[0].key); expect(next[0].hunk.id).toBe('new');
  });
  it('keeps add-only anchors and assigns all new keys when the caller switches identity', () => {
    const key = counter(), before = reconcileHunkViews([], [hunk('added', 0, 0)], key);
    expect(reconcileHunkViews(before, [hunk('updated', 0, 0)], key)[0].key).toBe(before[0].key);
    expect(reconcileHunkViews([], [hunk('updated', 0, 0)], key)[0].key).not.toBe(before[0].key);
  });
});
