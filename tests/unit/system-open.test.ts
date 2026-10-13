import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openSystemFile } from '../../src/core/system-open';
import { requiresSystemOpenConfirmation } from '../../src/core/system-open-policy';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let child: EventEmitter & { stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> };
const target = path.resolve('test-files', "中文 空格 ' & $(not-code).txt");
const realProcess = process;
beforeEach(() => {
  vi.stubGlobal('process', { ...realProcess, platform: 'win32', env: { ...realProcess.env, SystemRoot: 'C:\\Windows' } });
  vi.mocked(spawn).mockReset();
  vi.spyOn(fs, 'lstat').mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as any);
  child = Object.assign(new EventEmitter(), { stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const started = () => vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

it('passes the literal path only through the environment and uses a fixed encoded script', async () => {
  const validate = vi.fn(async () => {}), pending = openSystemFile(target, { validate });
  await started();
  const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
  expect(options).toMatchObject({ shell: false, windowsHide: true, env: { PI_DIFF_SYSTEM_OPEN_TARGET: target } });
  const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le');
  expect(script).toContain('$env:PI_DIFF_SYSTEM_OPEN_TARGET'); expect(script).toContain('$info.UseShellExecute = $true');
  expect(script).toContain('[System.Diagnostics.Process]::Start($info)');
  expect(script).not.toContain(target); expect(script).not.toMatch(/Invoke-Expression|WaitForExit|cmd \/c/);
  expect(validate).toHaveBeenCalledTimes(1);
  child.emit('exit', 0); await expect(pending).resolves.toEqual({ ok: true });
  expect(child.kill).not.toHaveBeenCalled();
});
it('reports association failures and does not retry', async () => {
  const pending = openSystemFile(target); const check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED', message: expect.stringContaining('No association') });
  await started(); child.stderr.emit('data', 'No association'); child.emit('exit', 1); await check;
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('reports a missing PowerShell executable without retrying', async () => {
  const pending = openSystemFile(target); const check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED' });
  await started(); child.emit('error', new Error('ENOENT')); await check;
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('kills only the launcher on timeout and explicitly reports an unknown result', async () => {
  vi.useFakeTimers();
  const pending = openSystemFile(target); const check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_TIMEOUT', message: expect.stringContaining('No automatic retry') });
  await vi.advanceTimersByTimeAsync(0); expect(spawn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); await check;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1);
  child.emit('exit', 0);
});
it('aborts a pending launcher on unload and refuses pre-aborted work', async () => {
  const controller = new AbortController(), pending = openSystemFile(target, { signal: controller.signal });
  const check = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  await started(); controller.abort(); await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
  await expect(openSystemFile(target, { signal: controller.signal })).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('refuses missing files, links, directories and failed last-moment validation without spawning', async () => {
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', message: expect.stringContaining('文件已不存在') });
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => true } as any);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'NOT_FILE' });
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isFile: () => false, isSymbolicLink: () => false } as any);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'NOT_FILE' });
  await expect(openSystemFile(target, { validate: async () => { throw new Error('File identity changed'); } })).rejects.toThrow('File identity changed');
  expect(spawn).not.toHaveBeenCalled();
});
it('refuses non-Windows platforms, relative paths and sensitive files', async () => {
  await expect(openSystemFile('relative.txt')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(openSystemFile(path.resolve('.env'))).rejects.toMatchObject({ code: 'PATH_DENIED' });
  vi.stubGlobal('process', { ...realProcess, platform: 'linux' });
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'SYSTEM_OPEN_UNSUPPORTED' });
  expect(spawn).not.toHaveBeenCalled();
});
it('requires confirmation for executable/script associations but not ordinary documents', () => {
  for (const suffix of ['EXE', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'msi', 'reg', 'lnk', 'url']) expect(requiresSystemOpenConfirmation(`folder/a.${suffix}`)).toBe(true);
  for (const suffix of ['txt', 'ts', 'tsx', 'pdf', 'docx', 'png']) expect(requiresSystemOpenConfirmation(`folder/a.${suffix}`)).toBe(false);
});
