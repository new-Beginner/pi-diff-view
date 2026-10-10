import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileSnapshot } from './contracts';
import { digest, fail, readSnapshot, safeResolve, sameSnapshot } from './path-policy';
import { atomicJson } from './storage';
/** No recursive deletions, only a recorded regular-file lifecycle. Backups are mandatory. */
export async function replaceSnapshot(root: string, value: string, expected: FileSnapshot, desired: FileSnapshot, backupDir: string): Promise<void> {
  if (expected.kind !== 'text' || desired.kind !== 'text' || (desired.exists && (desired.text === null || digest(desired.text) !== desired.hash))) fail('RESTORE_UNAVAILABLE', 'Complete validated text snapshots are required');
  const target = await safeResolve(root, value);
  if (!sameSnapshot(await readSnapshot(root, value), expected)) fail('FILE_CONFLICT', 'File changed outside this review; refresh before retrying');
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backups = await fs.readdir(backupDir);
  let backupBytes = 0;
  for (const file of backups) backupBytes += (await fs.stat(path.join(backupDir, file))).size;
  if (backups.length >= 1000 || backupBytes + expected.size + desired.size + 8192 > 64 * 1024 * 1024) fail('BACKUP_LIMIT', 'Recovery backup limit reached; export needed backups before clearing plugin history');
  const id = randomUUID();
  // A recovery record is complete before touching the workspace.
  await atomicJson(path.join(backupDir, `${id}.json`), { version: 1, root, path: value, before: expected, after: desired });
  if (!desired.exists) {
    if (!expected.exists) return;
    await safeResolve(root, value);
    if (!sameSnapshot(await readSnapshot(root, value), expected)) fail('FILE_CONFLICT', 'File changed before deletion');
    await fs.unlink(target);
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await safeResolve(root, value);
  const temp = path.join(path.dirname(target), `.diff-view-${id}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', desired.mode & 0o777 || 0o644);
    try { await handle.writeFile(desired.text!, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await safeResolve(root, value);
    if (!sameSnapshot(await readSnapshot(root, value), expected)) fail('FILE_CONFLICT', 'File changed before restore');
    if (!expected.exists) {
      // Exclusive creation avoids replacing a file that appeared after the final check.
      await fs.link(temp, target);
      await fs.unlink(temp);
    } else { await fs.rename(temp, target); }
    if (process.platform !== 'win32') await fs.chmod(target, desired.mode & 0o777);
  } finally { await fs.rm(temp, { force: true }); }
}
