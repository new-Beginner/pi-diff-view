import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicPath, fail } from './path-policy';

// Fixed script only: the validated path is data in the child environment, never code.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $env:PI_DIFF_SYSTEM_OPEN_TARGET
  [Environment]::SetEnvironmentVariable('PI_DIFF_SYSTEM_OPEN_TARGET', $null, 'Process')
  $info.UseShellExecute = $true
  [System.Diagnostics.Process]::Start($info) | Out-Null
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

export async function openSystemFile(target: string, options: { signal?: AbortSignal; validate?: () => Promise<void> } = {}): Promise<{ ok: true }> {
  if (process.platform !== 'win32') fail('SYSTEM_OPEN_UNSUPPORTED', '系统打开目前仅支持 Windows。 / System open currently supports Windows only.');
  assertPublicPath(target);
  if (!path.isAbsolute(target)) fail('INVALID_PATH', 'System open requires an absolute file path');
  const stat = await fs.lstat(target).catch(error => {
    if (error.code === 'ENOENT') fail('FILE_NOT_FOUND', '文件已不存在，无法系统打开。 / The file no longer exists.');
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) fail('NOT_FILE', 'Only regular files can be opened');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  if (!/^[a-z]:[\\/]/i.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) fail('SYSTEM_OPEN_FAILED', 'Invalid Windows system directory');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await options.validate?.();
  if (options.signal?.aborted) fail('PLUGIN_UNLOADED', 'Diff view unloaded; the file was not opened');
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PI_DIFF_SYSTEM_OPEN_TARGET: target }
    });
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ ok: true });
    };
    const abort = () => {
      finish(Object.assign(new Error('插件已卸载；系统打开结果未确认，不会自动重试。 / Plugin unloaded; open result unknown. No automatic retry.'), { code: 'PLUGIN_UNLOADED' }));
      child.kill();
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('系统打开超时，结果未确认；不会自动重试，请检查默认程序。 / System open timed out; result unknown. No automatic retry.'), { code: 'SYSTEM_OPEN_TIMEOUT' }));
      child.kill();
    }, 15000);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', value => { stderr = (stderr + value).slice(0, 4096); });
    child.once('error', error => finish(Object.assign(new Error(`无法启动系统打开。 / Could not start system open: ${error.message}`), { code: 'SYSTEM_OPEN_FAILED' })));
    child.once('exit', code => finish(code === 0 ? undefined : Object.assign(new Error(`系统打开失败，请检查文件关联。 / System open failed; check the default app.${stderr.trim() ? ` ${stderr.trim()}` : ''}`), { code: 'SYSTEM_OPEN_FAILED' })));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
