import fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import type { CaptureIdentity, FileSnapshot } from '../core/contracts';
import { isImagePath } from '../core/review-file-policy';
import { assertPublicPath, inside, readCapturedSnapshot, resolveCapturePath, safeResolve } from '../core/path-policy';
import { checkScratchAncestry } from '../core/capture-context';

export interface CapturedPath { capture: CaptureIdentity; before: FileSnapshot; }
export interface WorkspaceSnapshot { paths: CapturedPath[]; complete: boolean; notice: string; }
export const WORKSPACE_NOTICE = 'Workspace capture: at most 256 files, 4096 directory entries, 16 MiB text and 3 seconds per snapshot; credentials, private paths, dependencies and symlinks excluded. Only observed endpoints are retained; transient changes and uninstrumented/background writers cannot be proven. Renames are represented as deletion/addition.';
/** No Git, command interpretation, symlink traversal, or external-directory discovery. */
export async function snapshotWorkspace(root: string, privatePaths: string[]): Promise<WorkspaceSnapshot> {
  const result: WorkspaceSnapshot = { paths: [], complete: true, notice: WORKSPACE_NOTICE };
  const deadline = Date.now() + 3000;
  let entries = 0, bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    if (Date.now() > deadline || entries >= 4096 || result.paths.length >= 256) { result.complete = false; return; }
    let dir: Dir | undefined;
    const directories: string[] = [];
    try {
      if (directory !== root) await safeResolve(root, directory);
      if (privatePaths.some(p => inside(p, directory))) return;
      dir = await fs.opendir(directory);
      for await (const entry of dir) {
        if (++entries > 4096 || Date.now() > deadline || result.paths.length >= 256) { result.complete = false; break; }
        const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
        try {
          try { assertPublicPath(relative); } catch { continue; }
          if (privatePaths.some(p => inside(p, absolute)) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) directories.push(absolute);
          else if (entry.isFile() && !isImagePath(relative)) {
            const capture = await resolveCapturePath(root, relative, privatePaths);
            let before = await readCapturedSnapshot(root, capture, privatePaths);
            if (before.text !== null) {
              bytes += before.size;
              if (bytes > 16 * 1024 * 1024) { before = { ...before, kind: 'unavailable', text: null }; result.complete = false; }
            }
            result.paths.push({ capture, before });
          } else if (entry.isFile()) continue;
          else result.complete = false;
        } catch { result.complete = false; }
      }
      // Capture top-level manifests/lockfiles before spending the bounded scan on descendants.
      for (const child of directories) await walk(child);
    } catch { result.complete = false; }
    finally { await dir?.close().catch(() => {}); }
  };
  // Validate the root itself before opening any descendants.
  try { assertPublicPath(root); await checkScratchAncestry(root); await walk(root); } catch { result.complete = false; }
  return result;
}

// Kept as re-exports for existing maintenance callers.
export { beginCaptureLease, endCaptureLease, inspectCaptureLeases, retireLegacyCaptureLeases, type Lease } from '../core/capture-leases';
