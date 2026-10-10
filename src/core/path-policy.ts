import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_TEXT_BYTES, type CaptureIdentity, type FileSnapshot } from './contracts';
export function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: string): string { const p = path.resolve(value); return process.platform === 'win32' ? p.toLowerCase() : p; }
export function inside(root: string, target: string): boolean { const rel = path.relative(canonical(root), canonical(target)); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); }
function assertPathSyntax(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail('INVALID_PATH', 'Invalid file path');
  const portable = value.replace(/\\/g, '/');
  if (portable.split('/').includes('..')) fail('PATH_DENIED', 'Traversal paths cannot be captured');
  if (portable.startsWith('//') || portable.startsWith('/??/') || /^[a-z]:[^/]/i.test(portable) || portable.replace(/^[a-z]:\//i, '').includes(':')) fail('PATH_DENIED', 'UNC, device, drive-relative and alternate-stream paths are not reviewable');
}
export function assertPublicPath(value: string): void {
  assertPathSyntax(value);
  const parts = value.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    const s = part.toLowerCase();
    if (s === '..' || /[. ]$/.test(s) && s !== '.' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(s) || ['.git', '.ssh', '.aws', '.gnupg', '.gpg', '.npmrc', '.git-credentials', '.netrc', '_netrc', '.pi', '.claude', '.codex', '.pi-desktoooop', '.pi-desktop', '.pi-diff-view', 'node_modules'].includes(s) || s.startsWith('.env') || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) fail('PATH_DENIED', 'Credential, dependency, internal or escaping paths are not reviewable');
  }
}
/** Check every existing ancestor, refusing symlinks/junctions rather than following them. */
export async function safeResolve(root: string, value: string): Promise<string> {
  assertPathSyntax(value);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, value);
  if (!inside(realRoot, target) || canonical(target) === canonical(realRoot)) fail('PATH_ESCAPE', 'File is outside the authorized project root');
  const rel = path.relative(realRoot, target);
  assertPublicPath(rel);
  let cursor = realRoot;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', 'Symlinks and junctions are read-only metadata');
      const resolved = await fs.realpath(cursor);
      if (!inside(realRoot, resolved)) fail('PATH_ESCAPE', 'Resolved path escapes the project');
      assertPublicPath(path.relative(realRoot, resolved));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
/** Authorization is for exactly one explicitly supplied tool path, never its directory. */
export async function resolveCapturePath(root: string, value: string, privatePaths: string[], allowMissing = false): Promise<CaptureIdentity> {
  assertPathSyntax(root);
  assertPathSyntax(value);
  const absolute = path.resolve(root, value), origin = inside(root, absolute) ? 'workspace' : 'external';
  if (origin === 'workspace') assertPublicPath(root);
  if (origin === 'external' && !path.isAbsolute(value)) fail('PATH_ESCAPE', 'External capture requires an explicit absolute path');
  if (privatePaths.some(p => inside(p, absolute))) fail('PATH_DENIED', 'Plugin-private paths cannot be captured');
  assertPublicPath(origin === 'workspace' ? path.relative(root, absolute) : absolute);
  let target: string;
  if (origin === 'workspace') target = await safeResolve(root, value);
  else {
    // Walk from the filesystem root, checking before following each ancestor.
    let cursor = path.parse(absolute).root;
    const segments = absolute.slice(cursor.length).split(path.sep);
    for (const [i, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', 'Symlinks and junctions cannot be captured');
        if (i < segments.length - 1 && !stat.isDirectory()) fail('NOT_FILE', 'Capture ancestors must be directories');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
        break; // Remaining components are absent; syntax and the existing ancestry were already checked.
      }
    }
    target = absolute;
  }
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT' && allowMissing) return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('NOT_FILE', 'Only regular files can be captured');
  target = stat ? await fs.realpath(target) : target; // A Write may create missing parents. Re-walk on the after-snapshot before opening.
  if (origin === 'external') assertPublicPath(target);
  if (privatePaths.some(p => inside(p, target))) fail('PATH_DENIED', 'Plugin-private paths cannot be captured');
  if (origin === 'workspace' && !inside(root, target)) fail('PATH_ESCAPE', 'Capture escaped the workspace');
  if (origin === 'workspace') assertPublicPath(path.relative(root, target));
  const identity = canonical(target);
  return { id: digest(identity).slice(0, 24), identity, origin, absolutePath: target, path: origin === 'workspace' ? path.relative(root, target).split(path.sep).join('/') : target };
}
export async function readCapturedSnapshot(root: string, capture: CaptureIdentity, privatePaths: string[]): Promise<FileSnapshot> {
  const resolve = async () => {
    const live = await resolveCapturePath(root, capture.origin === 'workspace' ? capture.path : capture.absolutePath, privatePaths, true);
    if (live.identity !== capture.identity || live.origin !== capture.origin || live.id !== capture.id) fail('PATH_ESCAPE', 'Explicit capture identity changed');
    return live.absolutePath;
  };
  return readRegularSnapshot(await resolve(), resolve);
}
export function absentSnapshot(): FileSnapshot { return { exists: false, text: null, hash: 'absent', size: 0, mode: 0, kind: 'text' }; }
export function snapshotFromBytes(bytes: Uint8Array, mode = 0o100644): FileSnapshot {
  let kind: FileSnapshot['kind'] = bytes.length > MAX_TEXT_BYTES ? 'large' : 'text';
  let text: string | null = null;
  if (kind === 'text') {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) { kind = 'binary'; text = null; } }
    catch { kind = 'binary'; }
  }
  return { exists: true, text, hash: digest(bytes), size: bytes.length, mode, kind };
}
export function snapshotOfText(text: string, mode = 0o100644): FileSnapshot { return snapshotFromBytes(Buffer.from(text), mode); }
export function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean { return a.exists === b.exists && a.hash === b.hash && (!a.exists || (a.mode & 0o777) === (b.mode & 0o777)); }
export async function readSnapshot(root: string, value: string): Promise<FileSnapshot> {
  const target = await safeResolve(root, value);
  return readRegularSnapshot(target, () => safeResolve(root, value));
}
async function readRegularSnapshot(target: string, resolve: () => Promise<string>): Promise<FileSnapshot> {
  let handle: fs.FileHandle | undefined;
  try {
    const initial = await fs.lstat(target);
    if (!initial.isFile() || initial.isSymbolicLink()) fail('NOT_FILE', 'Only regular files can be captured');
    handle = await fs.open(target, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== initial.ino || stat.dev !== initial.dev) fail('NOT_FILE', 'Only the validated regular file can be captured');
    if (stat.size > MAX_TEXT_BYTES) {
      await resolve();
      return { exists: true, text: null, hash: `large:${stat.size}:${stat.mtimeMs}`, size: stat.size, mode: stat.mode, kind: 'large' };
    }
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > MAX_TEXT_BYTES) fail('FILE_CHANGED', 'File grew beyond the snapshot limit during capture');
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('FILE_CHANGED', 'File changed during capture');
    await resolve();
    const live = await fs.lstat(target);
    if (!live.isFile() || live.isSymbolicLink() || live.ino !== stat.ino || live.dev !== stat.dev || live.size !== after.size || live.mtimeMs !== after.mtimeMs) fail('FILE_CHANGED', 'File identity changed during capture');
    return snapshotFromBytes(bytes, stat.mode);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absentSnapshot(); throw error; }
  finally { await handle?.close(); }
}
