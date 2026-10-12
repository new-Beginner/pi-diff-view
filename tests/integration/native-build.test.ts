import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
import { inspectNativeHostBuild } from '../../src/core/native-host-build';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR ?? os.tmpdir(), 'native-build-')); await fs.mkdir(path.join(root, 'resources')); });
afterEach(async () => fs.rm(root, { recursive: true, force: true }));
it('unknown host versions stop before reading installation assets', async () => { const info = await inspectNativeHostBuild('0.18.0', path.join(root, 'app.exe')); expect(info.supported).toBe(false); expect(info.hashes).toEqual({}); expect(info.reason).toContain('Only'); });
it('missing or malformed archive returns a bounded explicit reason', async () => {
  const exe = path.join(root, 'app.exe'); expect((await inspectNativeHostBuild('0.17.0', exe)).supported).toBe(false);
  await fs.writeFile(path.join(root, 'resources/app.asar'), 'bad'); const info = await inspectNativeHostBuild('0.17.0', exe); expect(info.reason).toContain('Short ASAR');
  const header = Buffer.alloc(16); header.writeUInt32LE(0xffffffff, 12); await fs.writeFile(path.join(root, 'resources/app.asar'), header); expect((await inspectNativeHostBuild('0.17.0', exe)).reason).toContain('Invalid ASAR');
});
it('never follows a host archive symlink', async () => { await fs.writeFile(path.join(root, 'target'), 'bad'); await fs.symlink(path.join(root, 'target'), path.join(root, 'resources/app.asar')); expect((await inspectNativeHostBuild('0.17.0', path.join(root, 'app.exe'))).reason).toContain('regular'); });
