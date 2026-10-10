import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_TEXT_BYTES, type FileSnapshot } from './contracts';
export function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: string): string { const p = path.resolve(value); return process.platform === 'win32' ? p.toLowerCase() : p; }
export function inside(root: string, target: string): boolean { const rel = path.relative(canonical(root), canonical(target)); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); }
export function assertPublicPath(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail('INVALID_PATH', 'Invalid file path');
  const parts = value.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    const s = part.toLowerCase();
    if (s === '..' || ['.git', '.ssh', '.aws', '.gnupg', '.gpg', '.npmrc', '.git-credentials', '.netrc', '_netrc', '.pi-desktoooop', '.pi-desktop', 'node_modules'].includes(s) || s.startsWith('.env') || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) fail('PATH_DENIED', 'Credential, dependency, internal or escaping paths are not reviewable');
  }
}
/** Check every existing ancestor, refusing symlinks/junctions rather than following them. */
export async function safeResolve(root: string, value: string): Promise<string> {
  assertPublicPath(value);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, value);
  if (!inside(realRoot, target) || canonical(target) === canonical(realRoot)) fail('PATH_ESCAPE', 'File is outside the authorized project root');
  const rel = path.relative(realRoot, target);
  let cursor = realRoot;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', 'Symlinks and junctions are read-only metadata');
      if (!inside(realRoot, await fs.realpath(cursor))) fail('PATH_ESCAPE', 'Resolved path escapes the project');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
export function absentSnapshot(): FileSnapshot { return { exists: false, text: null, hash: 'absent', size: 0, mode: 0, kind: 'text' }; }
export function snapshotFromBytes(bytes: Uint8Array, mode = 0o100644): FileSnapshot {
  let kind: FileSnapshot['kind'] = bytes.length > MAX_TEXT_BYTES ? 'large' : 'text';
  let text: string | null = null;
  if (kind === 'text') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) { kind = 'binary'; text = null; } }
    catch { kind = 'binary'; }
  }
  return { exists: true, text, hash: digest(bytes), size: bytes.length, mode, kind };
}
export function snapshotOfText(text: string, mode = 0o100644): FileSnapshot { return snapshotFromBytes(Buffer.from(text), mode); }
export function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean { return a.exists === b.exists && a.hash === b.hash && (!a.exists || (a.mode & 0o777) === (b.mode & 0o777)); }
export async function readSnapshot(root: string, value: string): Promise<FileSnapshot> {
  const target = await safeResolve(root, value);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(target, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) fail('NOT_FILE', 'Only regular files can be captured');
    if (stat.size > MAX_TEXT_BYTES) return { exists: true, text: null, hash: `large:${stat.size}:${stat.mtimeMs}`, size: stat.size, mode: stat.mode, kind: 'large' };
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('FILE_CHANGED', 'File changed during capture');
    await safeResolve(root, value);
    return snapshotFromBytes(bytes, stat.mode);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absentSnapshot(); throw error; }
  finally { await handle?.close(); }
}
