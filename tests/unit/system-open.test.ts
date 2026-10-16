import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeSystemOpener, openSystemFile, warmSystemOpener } from '../../src/core/system-open';
import { requiresSystemOpenConfirmation } from '../../src/core/system-open-policy';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
type Child = EventEmitter & { stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }; stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }; stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> };
let child: Child;
const target = path.resolve('test-files', "中文 空格 ' & $(not-code).txt");
const realProcess = process;
const makeChild = (): Child => Object.assign(new EventEmitter(), {
  stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
  stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
  stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }), kill: vi.fn()
});
beforeEach(() => {
  vi.stubGlobal('process', { ...realProcess, platform: 'win32', env: { ...realProcess.env, SystemRoot: 'C:\\Windows' } });
  vi.mocked(spawn).mockReset();
  vi.spyOn(fs, 'lstat').mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as any);
  child = makeChild(); vi.mocked(spawn).mockReturnValue(child as any);
});
afterEach(() => { closeSystemOpener?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const started = () => vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
const ready = (value = child) => value.stdout.emit('data', '{"ready":true}\n');
const sent = () => JSON.parse(child.stdin.write.mock.calls.at(-1)![0] as string);
const acknowledge = (ok = true, error?: string) => child.stdout.emit('data', JSON.stringify({ id: sent().id, ok, error }) + '\n');
async function requested() { await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled()); }

it('prewarms without opening files and reuses one launcher for successive requests', async () => {
  warmSystemOpener(); await started(); ready();
  expect(child.stdin.write).not.toHaveBeenCalled();
  const first = openSystemFile(target); await requested(); acknowledge();
  await expect(first).resolves.toEqual({ ok: true });
  const firstId = sent().id;
  const second = openSystemFile(target); await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2));
  expect(sent().id).not.toBe(firstId); acknowledge(); await second;
  expect(spawn).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
});
it('passes paths as framed JSON data and uses a fixed encoded script', async () => {
  const validate = vi.fn(async () => {}), pending = openSystemFile(target, { validate });
  await started(); ready(); await requested();
  const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
  expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le');
  expect(script).toContain('ConvertFrom-Json'); expect(script).toContain('$info.FileName = [string]$request.path');
  expect(script).toContain('$info.UseShellExecute = $true'); expect(script).toContain('[System.Diagnostics.Process]::Start($info)');
  expect(script).not.toContain(target); expect(script).not.toMatch(/Invoke-Expression|WaitForExit|cmd \/c/);
  expect(sent()).toEqual({ id: expect.any(Number), path: target });
  expect(validate).toHaveBeenCalledTimes(1);
  acknowledge(); await expect(pending).resolves.toEqual({ ok: true });
});
it('revalidates after cold startup and refuses a target that disappeared while warming', async () => {
  const validate = vi.fn(async () => { throw Object.assign(new Error('File disappeared'), { code: 'FILE_NOT_FOUND' }); });
  const pending = openSystemFile(target, { validate });
  const check = expect(pending).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  await started(); expect(validate).not.toHaveBeenCalled(); ready(); await check;
  expect(child.stdin.write).not.toHaveBeenCalled();
});
it('reports association failures once and can accept a later explicit request', async () => {
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED', message: expect.stringContaining('No association') });
  await started(); ready(); await requested(); acknowledge(false, 'No association'); await check;
  expect(child.stdin.write).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1);
  const next = openSystemFile(target); await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledTimes(2)); acknowledge(); await next;
});
it('reports a missing PowerShell executable without retrying', async () => {
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED' });
  await started(); child.emit('error', new Error('ENOENT')); await check;
  expect(spawn).toHaveBeenCalledTimes(1); expect(child.stdin.write).not.toHaveBeenCalled();
});
it('kills only the launcher on timeout and explicitly reports an unknown result', async () => {
  vi.useFakeTimers();
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_TIMEOUT', message: expect.stringContaining('No automatic retry') });
  await vi.advanceTimersByTimeAsync(0); ready(); await vi.advanceTimersByTimeAsync(0);
  expect(child.stdin.write).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); await check;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1);
});
it('bounds prewarming and does not send requests after a startup timeout', async () => {
  vi.useFakeTimers(); warmSystemOpener();
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(15000); await check; ready();
  expect(child.stdin.write).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalledTimes(1);
});
it('aborts a pending launcher on unload and refuses pre-aborted work', async () => {
  const controller = new AbortController(), pending = openSystemFile(target, { signal: controller.signal });
  const check = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  await started(); ready(); await requested(); controller.abort(); await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
  await expect(openSystemFile(target, { signal: controller.signal })).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('refuses missing files, links, directories and invalid paths without starting a launcher', async () => {
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', message: expect.stringContaining('文件已不存在') });
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => true } as any);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'NOT_FILE' });
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isFile: () => false, isSymbolicLink: () => false } as any);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'NOT_FILE' });
  await expect(openSystemFile('relative.txt')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(openSystemFile(path.resolve('.env'))).rejects.toMatchObject({ code: 'PATH_DENIED' });
  expect(spawn).not.toHaveBeenCalled();
});
it('rejects concurrent opens and treats an unexpected launcher exit as unconfirmed, without replay', async () => {
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED', message: expect.stringContaining('No automatic retry') });
  await started(); ready(); await requested();
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'SYSTEM_OPEN_BUSY' });
  child.emit('exit', 0); await check; expect(child.stdin.write).toHaveBeenCalledTimes(1);
  const nextChild = makeChild(); vi.mocked(spawn).mockReturnValue(nextChild as any);
  const next = openSystemFile(target); await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2)); ready(nextChild);
  await vi.waitFor(() => expect(nextChild.stdin.write).toHaveBeenCalledTimes(1));
  const request = JSON.parse(nextChild.stdin.write.mock.calls[0][0] as string);
  nextChild.stdout.emit('data', JSON.stringify({ id: request.id, ok: true }) + '\n'); await next;
});
it('handles split acknowledgements and does not accept a mismatched request id', async () => {
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'SYSTEM_OPEN_FAILED' });
  await started(); child.stdout.emit('data', '{"ready":'); child.stdout.emit('data', 'true}\n'); await requested();
  child.stdout.emit('data', JSON.stringify({ id: sent().id + 1, ok: true }) + '\n'); await check;
  expect(child.stdin.write).toHaveBeenCalledTimes(1); expect(child.kill).toHaveBeenCalledTimes(1);
});
it('closes an unused prewarmed launcher and refuses non-Windows platforms', async () => {
  warmSystemOpener(); closeSystemOpener(); expect(child.kill).toHaveBeenCalledTimes(1);
  vi.stubGlobal('process', { ...realProcess, platform: 'linux' });
  warmSystemOpener(); expect(spawn).toHaveBeenCalledTimes(1);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'SYSTEM_OPEN_UNSUPPORTED' });
});
it('requires confirmation for executable/script associations but not ordinary documents', () => {
  for (const suffix of ['EXE', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'msi', 'reg', 'lnk', 'url']) expect(requiresSystemOpenConfirmation(`folder/a.${suffix}`)).toBe(true);
  for (const suffix of ['txt', 'ts', 'tsx', 'pdf', 'docx', 'png']) expect(requiresSystemOpenConfirmation(`folder/a.${suffix}`)).toBe(false);
});
it('does not spawn after unload while the initial file check is still pending', async () => {
  let release!: (value: unknown) => void;
  vi.mocked(fs.lstat).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as any);
  const pending = openSystemFile(target), check = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  closeSystemOpener(); release({ isFile: () => true, isSymbolicLink: () => false });
  await check; expect(spawn).not.toHaveBeenCalled();
});
it('cancels a click while the launcher is still warming without delivering a target', async () => {
  const controller = new AbortController(), pending = openSystemFile(target, { signal: controller.signal });
  const check = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_UNLOADED' });
  await started(); controller.abort(); await check; ready();
  expect(child.stdin.write).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalledTimes(1);
});
it('rechecks regular-file identity immediately before dispatch even on a warm launcher', async () => {
  warmSystemOpener(); ready();
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => false } as any)
    .mockResolvedValueOnce({ isFile: () => true, isSymbolicLink: () => true } as any);
  await expect(openSystemFile(target)).rejects.toMatchObject({ code: 'NOT_FILE' });
  expect(child.stdin.write).not.toHaveBeenCalled();
});
