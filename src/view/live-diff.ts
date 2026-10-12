import type { DiffHunk, DiffLine, ReviewFile } from '../core/contracts';

export const reviewFileVersion = (file: ReviewFile): string => `${file.fingerprint}|${file.kind}|${file.state}|${file.actions.join(',')}|${file.statsKnown}`;
export interface HunkView { key: string; hunk: DiffHunk }
const end = (hunk: DiffHunk) => hunk.oldStart + Math.max(1, hunk.oldLines) - 1;
const sameLine = (a: DiffLine, b: DiffLine) => a.kind === b.kind && a.text === b.text && a.oldLine === b.oldLine && a.newLine === b.newLine;

/** Backend hunk IDs change when earlier edits move blocks. UI keys must not control actions. */
export function reconcileHunkViews(previous: HunkView[], hunks: DiffHunk[], key: () => string): HunkView[] {
  const matches = new Map<DiffHunk, HunkView>(), used = new Set<HunkView>();
  const starts = new Map(previous.map(view => [view.hunk.oldStart, view]));
  // Reserve exact old-file anchors before overlapping blocks can claim them.
  for (const hunk of hunks) {
    const view = starts.get(hunk.oldStart);
    if (view && !used.has(view)) { matches.set(hunk, view); used.add(view); }
  }
  let cursor = 0;
  for (const hunk of hunks) {
    if (matches.has(hunk)) continue;
    while (cursor < previous.length && end(previous[cursor].hunk) < hunk.oldStart) cursor++;
    let best: HunkView | undefined, score = 0;
    for (let index = cursor; index < previous.length && previous[index].hunk.oldStart <= end(hunk); index++) {
      const view = previous[index];
      if (used.has(view)) continue;
      const overlap = Math.min(end(hunk), end(view.hunk)) - Math.max(hunk.oldStart, view.hunk.oldStart) + 1;
      if (overlap > score) { score = overlap; best = view; }
    }
    if (best) { matches.set(hunk, best); used.add(best); }
  }
  return hunks.map(hunk => {
    const prior = matches.get(hunk);
    if (!prior) return { key: key(), hunk };
    if (prior.hunk.lines.length === hunk.lines.length && prior.hunk.lines.every((line, i) => sameLine(line, hunk.lines[i]))) {
      hunk = { ...hunk, lines: prior.hunk.lines };
      if (prior.hunk.id === hunk.id && prior.hunk.header === hunk.header && prior.hunk.oldLines === hunk.oldLines && prior.hunk.newLines === hunk.newLines && prior.hunk.newStart === hunk.newStart) return prior;
    }
    return { key: prior.key, hunk };
  });
}

export interface ScrollAnchor { node?: HTMLElement; top: number; scrollTop: number; scrollLeft: number }
export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor {
  const bounds = viewport.getBoundingClientRect();
  const node = Array.from(viewport.querySelectorAll<HTMLElement>('.dv-row, .dv-pair, .dv-hunk-heading, .dv-file-row')).find(node => {
    const rect = node.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  return { node, top: node ? node.getBoundingClientRect().top - bounds.top : 0, scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft };
}
export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): void {
  // Preserve the visible element, not just a numeric offset, when rows are inserted above it.
  if (anchor.node?.isConnected && viewport.contains(anchor.node)) viewport.scrollTop += anchor.node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.top;
  else viewport.scrollTop = anchor.scrollTop;
  viewport.scrollLeft = anchor.scrollLeft;
}
