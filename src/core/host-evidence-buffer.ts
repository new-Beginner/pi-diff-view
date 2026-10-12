import { evidenceRevision } from './host-transcript';
export class HostEvidenceBuffer {
  private pending = new Map<string, { revision: string; root: string; next: number; chunks: string[]; bytes: number }>();
  private complete = new Map<string, { revision: string; root: string; messages: unknown[] }>();
  clear(): void { this.pending.clear(); this.complete.clear(); }
  messages(sessionId: string, root: string, revision?: string): unknown[] | undefined {
    const value = this.complete.get(sessionId);
    return value?.root === root && (!revision || value.revision === revision) ? value.messages : undefined;
  }
  append(input: { sessionId: string; root: string; revision: string; index: number; chunk: string; final: boolean }): void {
    const { sessionId, root, revision, index, chunk, final } = input;
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(sessionId) || !/^\d+-\d+$/.test(revision) || !Number.isSafeInteger(index) || index < 0 || typeof chunk !== 'string' || Buffer.byteLength(JSON.stringify(chunk)) > 28000) throw new Error('Invalid host evidence chunk');
    if (index === 0) {
      this.pending.delete(sessionId);
      this.pending.set(sessionId, { root, revision, next: 0, chunks: [], bytes: 0 });
      while (this.pending.size > 3) this.pending.delete(this.pending.keys().next().value!);
    }
    const value = this.pending.get(sessionId);
    if (!value || value.root !== root || value.revision !== revision || value.next !== index) throw new Error('Host evidence upload sequence mismatch');
    value.bytes += Buffer.byteLength(chunk);
    if (value.bytes > 8 * 1024 * 1024) { this.pending.delete(sessionId); throw new Error('Host evidence exceeds 8 MiB limit'); }
    value.chunks.push(chunk); value.next++;
    if (final) {
      this.pending.delete(sessionId);
      const source = value.chunks.join('');
      if (evidenceRevision(source) !== revision) throw new Error('Host evidence upload revision mismatch');
      const messages: unknown = JSON.parse(source);
      if (!Array.isArray(messages) || messages.length > 100000) throw new Error('Invalid host evidence messages');
      const previous = this.complete.get(sessionId);
      const merged = new Map<string, unknown>();
      if (previous?.root === root) for (const row of previous.messages as any[]) merged.set(row.id, row);
      for (const row of messages as any[]) {
        if (!row || row.type !== 'message' || typeof row.id !== 'string') throw new Error('Invalid host evidence row');
        merged.set(row.id, row);
      }
      const retained = [...merged.values()];
      if (retained.length > 100000 || Buffer.byteLength(JSON.stringify(retained)) > 8 * 1024 * 1024) throw new Error('Retained host evidence exceeds limit');
      this.complete.delete(sessionId); this.complete.set(sessionId, { root, revision, messages: retained });
      while (this.complete.size > 3) this.complete.delete(this.complete.keys().next().value!);
    }
  }
}
