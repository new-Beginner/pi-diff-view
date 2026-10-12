import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileSnapshot } from './contracts';
import { digest, fail, readSnapshot, safeResolve, sameSnapshot } from './path-policy';
import { atomicJson } from './storage';
/** Move the actual target aside before installing/deleting; never overwrite a newly appeared file. */
export async function replaceSnapshot(root: string, value: string, expected: FileSnapshot, desired: FileSnapshot, backupDir: string): Promise<void> {
  if (expected.kind !== 'text' || desired.kind !== 'text' || (desired.exists && (desired.text === null || digest(desired.text) !== desired.hash))) fail('RESTORE_UNAVAILABLE', 'Complete validated text snapshots are required');
  const target = await safeResolve(root, value);
  if (!sameSnapshot(await readSnapshot(root, value), expected)) fail('FILE_CONFLICT', 'File changed outside this review; refresh before retrying');
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backups = await fs.readdir(backupDir); let backupBytes = 0;
  for (const file of backups) backupBytes += (await fs.stat(path.join(backupDir, file))).size;
  if (backups.length >= 998 || backupBytes + 2 * expected.size + desired.size + 8192 > 64 * 1024 * 1024) fail('BACKUP_LIMIT', 'Recovery backup limit reached; export needed backups before clearing plugin history');
  const id = randomUUID(), record = path.join(backupDir, `${id}.json`);
  await atomicJson(record, { version: 1, root, path: value, before: expected, after: desired });
  if (!expected.exists && !desired.exists) return;
  await fs.mkdir(path.dirname(target), { recursive: true }); await safeResolve(root, value);
  const temp = path.join(path.dirname(target), `.diff-view-${id}.tmp`);
  const original = path.join(path.dirname(target), `.diff-view-${id}.original`);
  const originalRel = path.relative(root, original);
  let held = false;
  try {
    if (desired.exists) {
      const handle = await fs.open(temp, 'wx', desired.mode & 0o777 || 0o644);
      try { await handle.writeFile(desired.text!, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (process.platform !== 'win32') await fs.chmod(temp, desired.mode & 0o777);
    }
    await safeResolve(root, value);
    if (!sameSnapshot(await readSnapshot(root, value), expected)) fail('FILE_CONFLICT', 'File changed before restore');
    if (expected.exists) {
      await fs.rename(target, original); held = true;
      const actual = await readSnapshot(root, originalRel);
      if (!sameSnapshot(actual, expected)) fail('FILE_CONFLICT', 'Actual moved file changed; original content will be preserved');
      const rawBackup = path.join(backupDir, `${id}.original`);
      await fs.copyFile(original, rawBackup, constants.COPYFILE_EXCL);
      await fs.chmod(rawBackup, 0o600);
      if (!sameSnapshot(await readSnapshot(root, originalRel), expected)) fail('FILE_CONFLICT', 'Moved file changed while backing up');
    }
    if (desired.exists) await fs.link(temp, target); // Exclusive installation, including replacements.
    else if ((await readSnapshot(root, value)).exists) fail('FILE_CONFLICT', 'Another file appeared before deletion completed');
    if (held) { await fs.unlink(original); held = false; }
  } catch (error) {
    if (held) {
      try { await safeResolve(root, value); await fs.link(original, target); await fs.unlink(original); held = false; }
      catch { /* Never overwrite a new target. The actual original remains in the sibling recovery file. */ }
    }
    if (held) throw Object.assign(new Error(`${(error as Error).message}. Original preserved at ${original}`), { code: 'FILE_CONFLICT' });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('FILE_CONFLICT', 'Another file appeared; it was not overwritten');
    throw error;
  } finally { await fs.rm(temp, { force: true }); }
}
