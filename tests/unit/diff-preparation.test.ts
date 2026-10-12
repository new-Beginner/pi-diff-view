import { describe, it, expect, vi } from 'vitest';
import { prepareDiffDetail } from '../../src/view/useDiffDetail';
import type { ReviewDetail, ReviewFile, UiTransport } from '../../src/core/contracts';
const file: ReviewFile = { id: 'file', path: 'a.txt', status: 'modified', kind: 'text', additions: 1, deletions: 1, fingerprint: 'new', actions: [] };
function fixture(total = 240) {
  const lines = Array.from({ length: total }, (_, i) => ({ kind: 'context' as const, text: `${i}`, oldLine: i + 1, newLine: i + 1 }));
  const page = (offset: number, count = 80): ReviewDetail => ({ file, offset, totalRows: total, nextOffset: offset + count < total ? offset + count : null, hunks: [{ id: 'hunk', header: '@@', oldStart: 1, oldLines: total, newStart: 1, newLines: total, lines: lines.slice(offset, offset + count) }] });
  const invoke = vi.fn(async (_method: string, args: any) => page(args.offset));
  return { page, invoke, transport: { invoke } as unknown as UiTransport };
}
describe('off-screen diff preparation', () => {
  it('loads a complete replacement when the displayed version was complete, then reuses it', async () => {
    const f = fixture(); await prepareDiffDetail(f.transport, 'r', 'file', 3, 0, f.page(0, 240));
    expect(f.invoke.mock.calls.map(call => call[1].offset)).toEqual([0, 80, 160]);
    await prepareDiffDetail(f.transport, 'r', 'file', 3, 0, f.page(0, 240)); expect(f.invoke).toHaveBeenCalledTimes(3);
  });
  it('prepares only enough pages to cover the already displayed partial range', async () => {
    const f = fixture(); await prepareDiffDetail(f.transport, 'r', 'file', 3, 0, f.page(0, 160));
    expect(f.invoke.mock.calls.map(call => call[1].offset)).toEqual([0, 80]);
  });
  it('checks the old-file anchor as well as row count when insertions precede the viewport', async () => {
    const f = fixture(320), invoke = vi.fn(async (_method: string, args: any) => {
      const page = f.page(args.offset);
      page.hunks[0].lines = page.hunks[0].lines.map(line => ({ ...line, oldLine: line.oldLine! > 80 ? line.oldLine! - 80 : null }));
      return page;
    });
    await prepareDiffDetail({ invoke } as unknown as UiTransport, 'r', 'file', 3, 0, f.page(0, 160));
    expect(invoke.mock.calls.map(call => call[1].offset)).toEqual([0, 80, 160]);
  });
  it('stops paging after a navigation cancellation', async () => {
    const f = fixture(); await prepareDiffDetail(f.transport, 'r', 'file', 3, 0, f.page(0, 240), () => true);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('does not combine inconsistent versions or non-advancing pages', async () => {
    const f = fixture(), invoke = vi.fn(async (_method: string, args: any) => ({ ...f.page(args.offset), file: args.offset ? { ...file, fingerprint: 'different' } : file }));
    await expect(prepareDiffDetail({ invoke } as unknown as UiTransport, 'r', 'file', 3, 0, f.page(0, 240))).rejects.toThrow('Diff changed');
    const broken = vi.fn(async (_method: string, args: any) => ({ ...f.page(args.offset), nextOffset: args.offset }));
    await expect(prepareDiffDetail({ invoke: broken } as unknown as UiTransport, 'r', 'file', 3, 0)).rejects.toThrow('Invalid diff page');
  });
});
