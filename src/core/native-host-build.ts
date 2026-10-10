import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './path-policy';
import { NATIVE_BUILD, matchesNativeBuild, type NativeBuildInfo } from './native-build-contract';
/** Read only three fixed renderer assets from this process's host executable directory. No RPC paths. */
export async function inspectNativeHostBuild(version: string, executable = process.execPath): Promise<NativeBuildInfo> {
  const hashes: Record<string, string> = {};
  if (version !== NATIVE_BUILD.version) return { version, hashes, supported: false, reason: `Only the inspected PI-Desktop ${NATIVE_BUILD.version} build is supported` };
  let handle: fs.FileHandle | undefined;
  try {
    // Electron virtualizes .asar as a directory. original-fs reads the archive bytes; plain Node uses node:fs.
    let archiveFs = fs;
    try { archiveFs = require('original-fs').promises; } catch { /* Native Node host: regular fs already reads bytes. */ }
    const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
    const stat = await archiveFs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Host archive is not a regular file');
    handle = await archiveFs.open(archive, 'r');
    const header = Buffer.alloc(16);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error('Short ASAR header');
    const size = header.readUInt32LE(12), base = 8 + header.readUInt32LE(4);
    if (size < 2 || size > 2 * 1024 * 1024 || base < 16 + size || base > stat.size) throw new Error('Invalid ASAR bounds');
    const bytes = Buffer.alloc(size);
    if ((await handle.read(bytes, 0, size, 16)).bytesRead !== size) throw new Error('Short ASAR index');
    const index = JSON.parse(bytes.toString('utf8'));
    for (const asset of Object.values(NATIVE_BUILD.assets)) {
      let entry = index;
      for (const part of ['out', 'renderer', 'assets', asset.name]) entry = entry?.files?.[part];
      const offset = Number(entry?.offset), length = entry?.size;
      if (entry?.unpacked || entry?.link || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 2 * 1024 * 1024 || base + offset + length > stat.size) throw new Error('Pinned asset missing or invalid');
      const source = Buffer.alloc(length);
      if ((await handle.read(source, 0, length, base + offset)).bytesRead !== length) throw new Error('Short asset');
      hashes[asset.name] = digest(source);
    }
    const supported = matchesNativeBuild(version, hashes);
    return { version, hashes, supported, ...supported ? {} : { reason: 'Renderer build fingerprints do not match the inspected 0.17.0 build' } };
  } catch (error) { return { version, hashes, supported: false, reason: `Cannot verify pinned host assets: ${String((error as NodeJS.ErrnoException).code ?? (error as Error).message).slice(0, 200)}` }; }
  finally { await handle?.close(); }
}
