import { spawn } from 'node:child_process';
// Git for Windows recognizes /dev/null, but rejects node:os.devNull (\\.\\nul).
const devNull = '/dev/null';
import { fail } from '../core/path-policy';

export const OUTPUT_LIMIT = 16 * 1024 * 1024;
export interface GitResult { stdout: Buffer; stderr: string; code: number; }
/** No shell, inherited Git overrides, interactive prompts, hooks, fsmonitor or global config. */
export async function git(root: string, args: readonly string[], options: {
  input?: Buffer; index?: string; allowFailure?: boolean; limit?: number; timeout?: number;
} = {}): Promise<GitResult> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull, LC_ALL: 'C',
  });
  if (options.index) env.GIT_INDEX_FILE = options.index;
  const fixed = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'index.sparse=false',
    '-c', 'diff.external=', '-c', 'protocol.allow=never', '-c', 'core.pager=cat', '--no-pager', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('git', fixed, { cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, error: Error | undefined;
    const abort = (code: string, message: string) => {
      error ??= Object.assign(new Error(message), { code });
      child.kill();
    };
    const timer = setTimeout(() => abort('GIT_TIMEOUT', 'Git exceeded the time budget'), options.timeout ?? 15000);
    const collect = (parts: Buffer[], bytes: Buffer) => {
      size += bytes.length;
      if (size > (options.limit ?? OUTPUT_LIMIT)) abort('GIT_LIMIT', 'Git output exceeds the review budget');
      else parts.push(bytes);
    };
    child.stdout.on('data', bytes => collect(out, bytes));
    child.stderr.on('data', bytes => collect(err, bytes));
    child.on('error', cause => { error ??= cause; });
    child.stdin.on('error', cause => { if ((cause as NodeJS.ErrnoException).code !== 'EPIPE') error ??= cause; });
    child.on('close', code => {
      clearTimeout(timer);
      if (error) { reject(error); return; }
      const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code: code ?? -1 };
      if (result.code !== 0 && !options.allowFailure) {
        try { fail('GIT_FAILED', `Git ${args[0]} failed (${result.code})`); } catch (cause) { reject(cause); }
      } else resolve(result);
    });
    child.stdin.end(options.input);
  });
}

export function validateRef(ref: string): void {
  if (typeof ref !== 'string' || !ref || ref.length > 512 || ref.startsWith('-') ||
      /[\s\x00-\x1f\x7f\\:?[\]{}*]/u.test(ref) || ref.includes('..'))
    fail('INVALID_REF', 'Use a single local branch, tag or commit reference');
}
export async function resolveCommit(root: string, ref: string): Promise<string> {
  validateRef(ref);
  const value = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { limit: 4096 })).stdout.toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('INVALID_REF', 'Reference did not resolve to a commit');
  return value;
}
export async function headCommit(root: string): Promise<string | undefined> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { allowFailure: true, limit: 4096 });
  if (result.code === 1) return undefined;
  if (result.code !== 0) fail('GIT_FAILED', 'Could not resolve HEAD');
  const value = result.stdout.toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('GIT_FAILED', 'Invalid HEAD object');
  return value;
}
