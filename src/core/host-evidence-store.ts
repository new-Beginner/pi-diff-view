import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, MAX_RUNS, MAX_HISTORY_BYTES } from './storage';
import { canonical, digest } from './path-policy';
import { evidenceChunks, evidenceRevision, hostEvidenceMessages } from './host-transcript';
import type { HostEvidenceBuffer } from './host-evidence-buffer';

const LIMIT = 8 * 1024 * 1024;
interface EvidenceRecord { version: 1; sessionId: string; root: string; messages: unknown[] }
/** Plugin-owned evidence only: no chat prose, shell commands, stdout or host writes. */
export class HostEvidenceStore {
  private readonly directory: string;
  constructor(dataPath: string) { this.directory = path.join(dataPath, 'evidence'); }
  private file(sessionId: string, root: string): string {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(sessionId) || !path.isAbsolute(root)) throw new Error('Invalid persisted evidence identity');
    return path.join(this.directory, `${digest(`${sessionId}\0${canonical(root)}`)}.json`);
  }
  private async checkDirectory(): Promise<void> {
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe persisted evidence directory');
  }
  async restore(buffer: HostEvidenceBuffer, sessionId: string, root: string): Promise<void> {
    const file = this.file(sessionId, root);
    if (buffer.messages(sessionId, canonical(root))) return;
    await this.checkDirectory();
    let record: EvidenceRecord;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error('Unsafe persisted evidence record');
      record = await readJson<EvidenceRecord>(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (record.version !== 1 || record.sessionId !== sessionId || record.root !== canonical(root) || !Array.isArray(record.messages) || record.messages.length > 100000) throw new Error('Persisted evidence identity mismatch');
    // Reapply the allowlist on disk input, not just on renderer input.
    const source = JSON.stringify(hostEvidenceMessages(record.messages)), revision = evidenceRevision(source), chunks = evidenceChunks(source);
    for (const [index, chunk] of chunks.entries()) buffer.append({ sessionId, root: canonical(root), revision, index, chunk, final: index === chunks.length - 1 });
  }
  async save(buffer: HostEvidenceBuffer, sessionId: string, root: string): Promise<void> {
    const file = this.file(sessionId, root), messages = buffer.messages(sessionId, canonical(root));
    if (!messages) return;
    await this.checkDirectory();
    const record: EvidenceRecord = { version: 1, sessionId, root: canonical(root), messages: hostEvidenceMessages(messages) };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > LIMIT) throw new Error('Persisted evidence exceeds 8 MiB limit');
    // Fail closed at capacity rather than silently deleting other sessions' evidence.
    const entries = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const present = entries.includes(path.basename(file));
    if (!present && entries.length >= MAX_RUNS) throw new Error('Persisted evidence session limit reached');
    let size = bytes;
    for (const name of entries) if (name !== path.basename(file)) {
      const stat = await fs.lstat(path.join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe persisted evidence record');
      size += stat.size;
    }
    if (size > MAX_HISTORY_BYTES) throw new Error('Persisted evidence exceeds 128 MiB capacity');
    await atomicJson(file, record);
  }
}
