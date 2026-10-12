import { MAX_TEXT_BYTES } from './contracts';
import { digest } from './path-policy';

interface EditArgs { ops?: unknown; old_string?: unknown; new_string?: unknown }
interface Operation { start: number; end: number; body: string[] }

/** Replay data-only Edit instructions against verified historical bytes, never a live file.
 * Registers, moves and unsupported syntax fail closed. A recorded SHA-256 is mandatory.
 */
export function replayRecordedEdit(before: string, args: EditArgs, expectedHash: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || Buffer.byteLength(before) > MAX_TEXT_BYTES) return undefined;
  if (typeof args.ops !== 'string') {
    if (typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string') return undefined;
    const at = before.indexOf(args.old_string);
    if (at < 0 || before.indexOf(args.old_string, at + 1) !== -1) return undefined;
    const value = before.slice(0, at) + args.new_string + before.slice(at + args.old_string.length);
    return Buffer.byteLength(value) <= MAX_TEXT_BYTES && digest(value) === expectedHash ? value : undefined;
  }
  if (Buffer.byteLength(args.ops) > MAX_TEXT_BYTES) return undefined;
  const lines = before ? before.split('\n') : [];
  if (before.endsWith('\n')) lines.pop();
  const ops: Operation[] = [];
  const rows = args.ops.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < rows.length;) {
    const header = rows[index++];
    if (!header.trim()) continue;
    let start: number, end: number, put = false;
    let match: RegExpExecArray | null;
    if ((match = /^PUT (\d+)\.=(\d+):$/.exec(header))) {
      start = Number(match[1]) - 1; end = Number(match[2]); put = true;
    } else if ((match = /^CUT (\d+)\.=(\d+)$/.exec(header))) {
      start = Number(match[1]) - 1; end = Number(match[2]);
    } else if ((match = /^PUT <(\d+):$/.exec(header))) {
      start = end = Number(match[1]) - 1; put = true;
    } else if ((match = /^PUT >(\d+):$/.exec(header))) {
      start = end = Number(match[1]); put = true;
      if (start < 1) return undefined;
    } else if (header === 'PUT >$:') {
      start = end = lines.length; put = true;
    } else return undefined;
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > lines.length || (end === start && !/^PUT [<>]/.test(header))) return undefined;
    const body: string[] = [];
    if (put) while (index < rows.length && rows[index].startsWith('+')) body.push(rows[index++].slice(1));
    ops.push({ start, end, body });
    if (ops.length > 4096) return undefined;
  }
  if (!ops.length) return undefined;
  ops.sort((a, b) => a.start - b.start || a.end - b.end);
  const output: string[] = [];
  let cursor = 0, previousStart = -1;
  for (const op of ops) {
    // Reject ambiguous/overlapping anchors rather than guessing the host's ordering.
    if (op.start < cursor || op.start === previousStart) return undefined;
    for (; cursor < op.start; cursor++) output.push(lines[cursor]);
    for (const line of op.body) output.push(line);
    cursor = op.end; previousStart = op.start;
  }
  for (; cursor < lines.length; cursor++) output.push(lines[cursor]);
  const clean = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line;
  const variants = new Set([output.join('\n'), output.map(clean).join('\n'), output.map(clean).join('\r\n')]);
  for (const text of variants) for (const suffix of ['', '\n', '\r\n']) {
    const value = text + suffix;
    if (Buffer.byteLength(value) <= MAX_TEXT_BYTES && digest(value) === expectedHash) return value;
  }
  return undefined;
}
