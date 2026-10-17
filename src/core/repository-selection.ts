import path from 'node:path';
import { canonical, digest, fail } from './path-policy';
import { atomicJson, readJson } from './storage';
interface Selection { workspace: string; sessionId?: string; root: string }
export function workspaceKey(roots: readonly string[]): string { return digest(JSON.stringify(roots.map(canonical).sort())); }
function validateSession(sessionId?: string): void {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId))) fail('SESSION_REQUIRED', 'Invalid session identity');
}
export class RepositorySelection {
  private tail = Promise.resolve();
  constructor(private directory: string) {}
  private async read(): Promise<Selection[]> {
    const rows = await readJson<unknown>(path.join(this.directory, 'repository-selection.json'), []);
    return Array.isArray(rows) ? rows.filter((row): row is Selection => row && typeof row.workspace === 'string' && typeof row.root === 'string' && path.isAbsolute(row.root) && (row.sessionId === undefined || typeof row.sessionId === 'string')).slice(-200) : [];
  }
  async get(workspace: string, sessionId?: string): Promise<string | undefined> {
    validateSession(sessionId); await this.tail;
    const rows = await this.read();
    return rows.find(row => row.workspace === workspace && row.sessionId === sessionId)?.root
      ?? rows.find(row => row.workspace === workspace && !row.sessionId)?.root;
  }
  set(workspace: string, root: string, sessionId?: string): Promise<void> {
    validateSession(sessionId);
    const task = this.tail.then(async () => {
      const rows = (await this.read()).filter(row => row.workspace !== workspace || (row.sessionId !== undefined && row.sessionId !== sessionId));
      rows.push({ workspace, root });
      if (sessionId) rows.push({ workspace, sessionId, root });
      await atomicJson(path.join(this.directory, 'repository-selection.json'), rows.slice(-200));
    });
    this.tail = task.catch(() => {}); return task;
  }
}
