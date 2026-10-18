import { describe, expect, it } from 'vitest';
import type { ReviewFile } from '../../src/core/contracts';
import { isVisibleReviewFile } from '../../src/core/review-file-policy';

const file = (extra: Partial<ReviewFile> = {}): ReviewFile => ({ id: 'file', path: 'src/file.ts', status: 'modified', kind: 'text', additions: 0, deletions: 0, statsKnown: true, fingerprint: 'v1', actions: [], ...extra });

describe('sidebar file visibility', () => {
  it.each(['modified', 'added', 'deleted', 'mode', 'renamed'] as const)('hides known +0 -0 entries with %s status', status => {
    expect(isVisibleReviewFile(file({ status }))).toBe(false);
  });
  it('supports legacy text entries without an explicit statsKnown flag', () => {
    expect(isVisibleReviewFile(file({ statsKnown: undefined }))).toBe(false);
  });
  it.each([{ additions: 1 }, { deletions: 1 }, { status: 'deleted' as const, deletions: 3 }])('keeps genuine line changes: %j', extra => {
    expect(isVisibleReviewFile(file(extra))).toBe(true);
  });
  it.each([
    { statsKnown: false },
    { kind: 'unavailable' as const },
    { kind: 'binary' as const },
    { segmentCount: 2 },
  ])('hides only deleted unknown entries: %j', extra => {
    expect(isVisibleReviewFile(file({ ...extra, status: 'deleted' }))).toBe(false);
    expect(isVisibleReviewFile(file(extra))).toBe(true);
  });
  it('continues excluding image paths even with positive stats', () => {
    expect(isVisibleReviewFile(file({ path: 'image.PNG', additions: 1 }))).toBe(false);
  });
});
