import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SnapshotStore } from '../../src/core/storage';
import { beginCaptureLease, endCaptureLease, inspectCaptureLeases, retireLegacyCaptureLeases } from '../../src/agent/workspace-capture';
it('retires exact confirmed legacy IDs with a fresh journal and backup, preserves real concurrent writers', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'lease-life-')), root = path.join(dir, 'project');
  const store = new SnapshotStore(dir); await store.init();
  try {
    const legacy = await beginCaptureLease(store, root, 'old'), first = await inspectCaptureLeases(store);
    await expect(retireLegacyCaptureLeases(store, root, [legacy], first.fingerprint, false)).rejects.toThrow('confirmation');
    const active = await beginCaptureLease(store, root, 'active', [path.join(root, 'a.txt')], { sessionId: 's', toolCallId: 'call', executionId: 'exec' });
    await expect(retireLegacyCaptureLeases(store, root, [legacy], first.fingerprint, true)).rejects.toThrow('changed');
    const current = await inspectCaptureLeases(store);
    await expect(retireLegacyCaptureLeases(store, root, [active], current.fingerprint, true)).rejects.toThrow('non-legacy');
    await retireLegacyCaptureLeases(store, root, [legacy], current.fingerprint, true);
    expect((await inspectCaptureLeases(store)).leases.map(l => l.id)).toEqual([active]);
    expect(await endCaptureLease(store, active)).toBe(true); // Past overlap remains honest.
    const clean = await beginCaptureLease(store, root, 'new', [path.join(root, 'a.txt')]); expect(await endCaptureLease(store, clean)).toBe(false);
    expect(await fs.readdir(path.join(dir, 'backups'))).toHaveLength(1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
