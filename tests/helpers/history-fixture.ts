import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { HostHistoryImporter as PublicHistoryImporter, type HistoryEvidenceSource } from '../../src/core/host-history';
import { MAX_TEXT_BYTES } from '../../src/core/contracts';
import { inside } from '../../src/core/path-policy';
import type { SnapshotStore } from '../../src/core/storage';
export { hostHistoryRunId, type HostHistoryRun } from '../../src/core/host-history';
const ID = /^[a-zA-Z0-9-]{1,80}$/;
/** Legacy archive fixtures are test-only, never bundled in the plugin. */
class FixtureArchive implements HistoryEvidenceSource {
  readonly privateRoot: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Host data root must be absolute');
    this.privateRoot = path.resolve(root);
  }
  scratchRoot(id: string): string { if (!ID.test(id)) throw new Error('Invalid history session'); return path.join(this.privateRoot, 'scratch', id); }
  private async checked(relative: string, directory = false): Promise<string> {
    const target = path.resolve(this.privateRoot, relative);
    if (!inside(this.privateRoot, target)) throw new Error('Host evidence escape');
    let cursor = path.parse(target).root;
    for (const segment of target.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== target && !stat.isDirectory())) throw new Error('Unsafe host evidence ancestry');
    }
    const stat = await fs.lstat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid host evidence type');
    return target;
  }
  private async read(relative: string, limit: number): Promise<Buffer> {
    const file = await this.checked(relative), initial = await fs.lstat(file);
    const handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new Error('Host evidence limit/identity');
      const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1)); let length = 0;
      while (length < bytes.length) { const r = await handle.read(bytes, length, bytes.length - length, length); if (!r.bytesRead) break; length += r.bytesRead; }
      const after = await handle.stat(); await this.checked(relative); const live = await fs.lstat(file);
      if (length > limit || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || live.ino !== stat.ino || live.dev !== stat.dev) throw new Error('Host evidence changed; retry sync');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  async transcript(id: string): Promise<string> { return (await this.read(`sessions/${id}.jsonl`, 64 * 1024 * 1024)).toString('utf8'); }
  async changes(id: string): Promise<{ meta: Record<string, any>; directory: string }[]> {
    const relative = `review-changes/${id}`, dir = await this.checked(relative, true);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.length > 4096) throw new Error('Host modification directory limit exceeded');
    const results: { meta: Record<string, any>; directory: string }[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = `${relative}/${entry.name}`;
      const meta: unknown = JSON.parse((await this.read(`${directory}/meta.json`, 64 * 1024)).toString('utf8'));
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) results.push({ meta, directory });
    }
    return results;
  }
  snapshot(directory: string, side: 'before' | 'after'): Promise<Buffer> { return this.read(`${directory}/${side}`, MAX_TEXT_BYTES); }
}
export class HostHistoryImporter extends PublicHistoryImporter {
  constructor(store: SnapshotStore, root: string) { super(store, new FixtureArchive(root)); }
}
