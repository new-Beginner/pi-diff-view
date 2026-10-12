import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCaptureContext, writeCaptureContexts, CAPTURE_CONTEXT_TTL } from '../../src/core/capture-context';
it('accepts fresh exact host identity and rejects stale, stopped, cross-root/session/generation metadata', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'capture-context-'));
  try {
    const now = Date.now(), root = path.resolve(dir, 'project');
    const context = { sessionId: 's', root, running: true, taskId: 'user-1', since: now - 100, updatedAt: now };
    await writeCaptureContexts(dir, 'generation', [context]);
    expect(await readCaptureContext(dir, 'generation', 's', root, now)).toEqual(context);
    for (const [generation, sessionId, project, time] of [['other', 's', root, now], ['generation', 'other', root, now], ['generation', 's', path.resolve(dir, 'other'), now], ['generation', 's', root, now + CAPTURE_CONTEXT_TTL + 1]] as const) expect(await readCaptureContext(dir, generation, sessionId, project, time)).toBeNull();
    for (const changed of [{ running: false }, { taskId: 'turn:unverified' }, { since: now + 1 }, { updatedAt: now + 1 }]) {
      await writeCaptureContexts(dir, 'generation', [{ ...context, ...changed }]);
      expect(await readCaptureContext(dir, 'generation', 's', root, now)).toBeNull();
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
