import path from 'node:path';
import { vi } from 'vitest';
import type { CaptureRun, CapturedChange, FileSnapshot } from '../../src/core/contracts';
import { canonical, digest, inside, snapshotOfText } from '../../src/core/path-policy';
import type { SnapshotStore } from '../../src/core/storage';

export interface PublicSessionFixture {
  messages: any[];
  projectPath?: string;
  isRunning?: boolean;
  currentTurnId?: string;
  status?: 'missing' | 'denied';
}
/** Exact public Desktop contracts; unexpected/private operations fail the test. */
export function publicDesktopFixture(sessions: Record<string, PublicSessionFixture>) {
  return {
    listOperations: vi.fn(async () => [
      { id: 'agent/getStatus', risk: 'read', description: 'Read agent status' },
      { id: 'session/get', risk: 'read', description: 'Read session messages' },
    ]),
    invoke: vi.fn(async ({ operation, args }: { operation: string; args: any[] }) => {
      if (operation === 'agent/getStatus') {
        const sessionId = args[0], row = sessions[sessionId];
        if (row?.status === 'denied') throw Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED' });
        if (!row || row.status === 'missing') return {};
        return { status: { sessionId, isRunning: row.isRunning ?? false, ...(row.currentTurnId ? { currentTurnId: row.currentTurnId } : {}) } };
      }
      if (operation === 'session/get') {
        const id = args[0].id, row = sessions[id];
        return { session: { id, ...(row?.projectPath ? { projectPath: row.projectPath } : {}), messages: row?.messages ?? [] }, messageStart: 0, messageEnd: row?.messages.length ?? 0, hasMoreBefore: false };
      }
      throw new Error(`Unexpected Desktop operation: ${operation}`);
    }),
  };
}
// The production source captures Date.now at construction: wait rather than replacing it later.
export const expirePublicCache = () => new Promise(resolve => setTimeout(resolve, 1100));
export function unavailableText(text: string): FileSnapshot {
  return { ...snapshotOfText(text), text: null, kind: 'unavailable' };
}
export function capturedChange(root: string, target: string, before: FileSnapshot, after: FileSnapshot, evidence: string[]): CapturedChange {
  const absolutePath = path.resolve(root, target), identity = canonical(absolutePath);
  const origin = inside(root, absolutePath) ? 'workspace' : 'external';
  return { capture: { id: digest(identity).slice(0, 24), identity, absolutePath, origin, path: origin === 'workspace' ? path.relative(root, absolutePath).split(path.sep).join('/') : absolutePath }, before, after, evidence };
}
export async function seedCapture(store: SnapshotStore, options: { id: string; sessionId: string; root: string; userMessageId: string; startedAt: number; changes: Record<string, CapturedChange>; inbox?: boolean }) {
  await store.init();
  const { inbox, ...values } = options;
  const run: CaptureRun = { version: 2, generation: 'fixture-agent', boundary: 'user', state: 'unknown', incomplete: true, fileCount: Object.keys(values.changes).length, replies: [], bindings: {}, ...values };
  await store.writeRun(run, inbox);
  return run;
}
