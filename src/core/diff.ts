import { structuredPatch, createTwoFilesPatch, diffArrays } from 'diff';
import type { DiffHunk, DiffLine, InternalFile, ReviewFile } from './contracts';
export function buildHunks(before: string, after: string, context = 3): DiffHunk[] {
  const patch = structuredPatch('before', 'after', before, after, '', '', { context, maxEditLength: 200000, timeout: 1000 });
  if (!patch) throw Object.assign(new Error('Diff exceeds computation budget'), { code: 'DIFF_LIMIT' });
  return patch.hunks.map((h, index) => {
    let old = h.oldStart, next = h.newStart;
    const lines: DiffLine[] = h.lines.map(line => {
      const sign = line[0];
      if (sign === '\\') return { kind: 'notice', text: line, oldLine: null, newLine: null };
      const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'context';
      return { kind, text: line.slice(1), oldLine: kind === 'add' ? null : old++, newLine: kind === 'del' ? null : next++ };
    });
    // Stable across view pagination, but not across a context-size change.
    return { id: `${index}:${h.oldStart}:${h.newStart}`, header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
  });
}
export function publicFile(file: InternalFile): ReviewFile { const { before: _before, after: _after, indexFingerprint: _index, ...rest } = file; return rest; }
export function patchText(file: InternalFile): string {
  if (file.kind !== 'text') return `${file.path}: ${file.kind}\n`;
  const quote = (s: string) => /[\s"\\]/.test(s) ? JSON.stringify(s) : s;
  return createTwoFilesPatch(file.before.exists ? quote(`a/${file.oldPath ?? file.path}`) : '/dev/null', file.after.exists ? quote(`b/${file.path}`) : '/dev/null', file.before.text ?? '', file.after.text ?? '', '', '', { context: 3 });
}
export function stats(before: string, after: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const hunk of buildHunks(before, after)) for (const line of hunk.lines) { if (line.kind === 'add') additions++; if (line.kind === 'del') deletions++; }
  return { additions, deletions };
}
/** Replace a selected exact line edit in the baseline, preserving its original newline bytes. */
export function selectHunkText(before: string, after: string, hunkId: string): string {
  const hunks = buildHunks(before, after);
  const h = hunks.find(h => h.id === hunkId);
  if (!h) throw Object.assign(new Error('Hunk changed; refresh the review'), { code: 'STALE_HUNK' });
  const split = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
  const newStart = h.newLines === 0 ? h.newStart : h.newStart - 1;
  return [...left.slice(0, start), ...right.slice(newStart, newStart + h.newLines), ...left.slice(start + h.oldLines)].join('');
}
export function inlineParts(before: string, after: string): { old: { text: string; changed: boolean }[]; next: { text: string; changed: boolean }[] } {
  if (before.length + after.length > 4000) return { old: [{ text: before, changed: false }], next: [{ text: after, changed: false }] };
  const changes = diffArrays([...before], [...after], { timeout: 20 });
  if (!changes) return { old: [{ text: before, changed: false }], next: [{ text: after, changed: false }] };
  return { old: changes.filter(c => !c.added).map(c => ({ text: c.value.join(''), changed: !!c.removed })), next: changes.filter(c => !c.removed).map(c => ({ text: c.value.join(''), changed: !!c.added })) };
}
