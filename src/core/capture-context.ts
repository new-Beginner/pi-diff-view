import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical } from './path-policy';
import { hostScratchRoot } from './public-path';
import { atomicJson } from './storage';
export interface CaptureContext { sessionId: string; root: string; running: boolean; mainRunning?: boolean; statusKnown?: boolean; taskId?: string; since?: number; updatedAt: number }
export const CAPTURE_CONTEXT_TTL = 6000;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9-]{1,256}$/.test(v);
export async function writeCaptureContexts(directory: string, generation: string, contexts: CaptureContext[]): Promise<void> {
  await atomicJson(path.join(directory, 'capture-contexts.json'), { version: 1, generation, contexts: contexts.slice(-200) });
}
/** Trusted renderer metadata only. Never promote an already captured uncertain run. */
export async function readCaptureContext(directory: string, generation: string, sessionId: string, root: string, now = Date.now()): Promise<CaptureContext | null> {
  try {
    const file = path.join(directory, 'capture-contexts.json'), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    if (document.version !== 1 || document.generation !== generation || !Array.isArray(document.contexts) || document.contexts.length > 200) return null;
    const context = document.contexts.find((v: CaptureContext) => v?.sessionId === sessionId);
    if (!context || context.running !== true || !id(context.taskId) || typeof context.root !== 'string' || !path.isAbsolute(context.root) || canonical(context.root) !== canonical(root) || !Number.isSafeInteger(context.since) || context.since <= 0 || context.since > now || !Number.isSafeInteger(context.updatedAt) || context.updatedAt > now || now - context.updatedAt > CAPTURE_CONTEXT_TTL) return null;
    return context;
  } catch { return null; }
}
/** safeResolve treats a workspace root as trusted; host scratch must not follow a junction root. */
export async function checkScratchAncestry(value: string): Promise<void> {
  if (!hostScratchRoot(value)) return;
  const absolute = path.resolve(value);
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe scratch capture ancestry');
  }
}
