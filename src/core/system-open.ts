import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicPath, fail } from './path-policy';

// Fixed code only. Requests arrive as JSON data on stdin, never as shell commands.
// Warm the JSON cmdlets and .NET types before declaring readiness; startup never opens a file.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$null = ConvertFrom-Json -InputObject '{"id":0}'
$null = New-Object System.Diagnostics.ProcessStartInfo
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ready=$true} -Compress))
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = [string]$request.path
    $info.UseShellExecute = $true
    $opened = [System.Diagnostics.Process]::Start($info)
    if ($null -ne $opened) { $opened.Dispose() }
    $response = @{id=$request.id; ok=$true}
  } catch {
    $response = @{id=$request.id; ok=$false; error=$_.Exception.Message}
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress))
}`;
const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const unloaded = () => coded('PLUGIN_UNLOADED', '插件已卸载；系统打开结果未确认，不会自动重试。 / Plugin unloaded; open result unknown. No automatic retry.');
const timeout = () => coded('SYSTEM_OPEN_TIMEOUT', '系统打开超时，结果未确认；不会自动重试，请检查默认程序。 / System open timed out; result unknown. No automatic retry.');
const failed = (reason: string) => coded('SYSTEM_OPEN_FAILED', `系统打开失败，请检查文件关联；结果未确认，不会自动重试。 / System open failed; result unknown. No automatic retry. ${reason}`);
interface Launcher { ready: Promise<void>; stop(error: Error): void; send(target: string): Promise<{ ok: true }> }
let launcher: Launcher | undefined, activeOpen: object | undefined, epoch = 0;

function getLauncher(): Launcher {
  if (launcher) return launcher;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  if (!/^[a-z]:[\\/]/i.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) fail('SYSTEM_OPEN_FAILED', 'Invalid Windows system directory');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Prewarming has no caller to consume an error. Explicit opens still await the original promise.
  void ready.catch(() => {});
  let closed = false, warmed = false, buffer = '', stderr = '', sequence = 0;
  let pending: { id: number; finish(error?: Error): void } | undefined;
  const startupTimer = setTimeout(() => state.stop(timeout()), 15000);
  const state: Launcher = {
    ready,
    stop(error) {
      if (closed) return;
      closed = true; clearTimeout(startupTimer);
      if (launcher === state) launcher = undefined;
      rejectReady(error); pending?.finish(error); child.kill();
    },
    send(target) {
      if (closed || !warmed) return Promise.reject(failed('Launcher unavailable'));
      if (pending) return Promise.reject(coded('SYSTEM_OPEN_BUSY', 'A system-open request is already pending'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => state.stop(timeout()), 15000);
        const request = { id: ++sequence, finish(error?: Error) {
          if (pending !== request) return;
          pending = undefined; clearTimeout(timer);
          if (error) reject(error); else resolve({ ok: true });
        } };
        pending = request;
        try { child.stdin!.write(JSON.stringify({ id: request.id, path: target }) + '\n', 'utf8'); }
        catch (error) { state.stop(failed(String((error as Error).message))); }
      });
    }
  };
  launcher = state;
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', value => { stderr = (stderr + value).slice(0, 4096); });
  child.stdout!.on('data', value => {
    if (closed) return;
    buffer += value;
    if (buffer.length > 16384) { state.stop(failed('Launcher response too large')); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0 && !closed) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        if (!warmed && response.ready === true) { warmed = true; clearTimeout(startupTimer); resolveReady(); }
        else if (pending && response.id === pending.id && typeof response.ok === 'boolean') pending.finish(response.ok ? undefined : failed(String(response.error ?? '').slice(0, 4096)));
        else state.stop(failed('Unexpected launcher acknowledgement'));
      } catch { state.stop(failed('Invalid launcher response')); }
    }
  });
  child.stdin!.on('error', error => state.stop(failed(error.message)));
  child.once('error', error => state.stop(failed(error.message)));
  child.once('exit', () => state.stop(failed(stderr.trim() || 'Launcher exited')));
  return state;
}
/** One plugin-lifetime launcher; no file targets or new permissions are needed to prewarm. */
export function warmSystemOpener(): void {
  if (process.platform !== 'win32') return;
  try { getLauncher(); } catch { /* The next explicit click reports startup failure; never auto-replay. */ }
}
export function closeSystemOpener(): void { epoch++; activeOpen = undefined; launcher?.stop(unloaded()); }
async function assertRegularFile(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(error => {
    if (error.code === 'ENOENT') fail('FILE_NOT_FOUND', '文件已不存在，无法系统打开。 / The file no longer exists.');
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) fail('NOT_FILE', 'Only regular files can be opened');
}
export async function openSystemFile(target: string, options: { signal?: AbortSignal; validate?: () => Promise<void> } = {}): Promise<{ ok: true }> {
  if (process.platform !== 'win32') fail('SYSTEM_OPEN_UNSUPPORTED', '系统打开目前仅支持 Windows。 / System open currently supports Windows only.');
  if (options.signal?.aborted) throw unloaded();
  assertPublicPath(target);
  if (!path.isAbsolute(target)) fail('INVALID_PATH', 'System open requires an absolute file path');
  if (activeOpen) fail('SYSTEM_OPEN_BUSY', 'A system-open request is already pending');
  const token = {}, generation = epoch; activeOpen = token;
  let worker: Launcher | undefined;
  const guard = () => { if (options.signal?.aborted || generation !== epoch) throw unloaded(); };
  const abort = () => worker?.stop(unloaded());
  try {
    await assertRegularFile(target); guard();
    worker = getLauncher(); options.signal?.addEventListener('abort', abort, { once: true });
    guard(); await worker.ready; guard();
    // Never cache authorization across clicks or across cold startup.
    await options.validate?.(); await assertRegularFile(target); guard();
    return await worker.send(target);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (activeOpen === token) activeOpen = undefined;
  }
}
