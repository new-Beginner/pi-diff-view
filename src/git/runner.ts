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

export interface GitBlob { size: number; bytes?: Buffer; }
/** OIDs only: never paths, filters, textconv, replacement objects or lazy fetches. */
export async function readGitBlobs(root: string, requested: readonly string[], options: {
  budget: number; maxSize: number; deadline: number;
}): Promise<Map<string, GitBlob>> {
  const oids = [...new Set(requested)], result = new Map<string, GitBlob>();
  if (!oids.length) return result;
  if (oids.length > 20000 || oids.some(oid => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))
    fail('GIT_LIMIT', 'Invalid or excessive Git object request');
  const timeout = () => {
    const left = options.deadline - Date.now();
    if (left <= 0) fail('GIT_TIMEOUT', 'Review exceeded the time budget');
    return Math.min(15000, left);
  };
  const input = (values: string[]) => Buffer.from(`${values.join('\n')}\n`, 'ascii');
  const checked = await git(root, ['cat-file', '--batch-check'], { input: input(oids), timeout: timeout() });
  const rows = checked.stdout.toString('ascii').split('\n');
  if (rows.pop() !== '' || rows.length !== oids.length) fail('GIT_FAILED', 'Invalid Git batch size response');
  const selected: string[] = [];
  let budget = Math.max(0, Math.min(OUTPUT_LIMIT, options.budget)), wireSize = 0;
  for (let i = 0; i < oids.length; i++) {
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(rows[i]);
    const size = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== oids[i] || !Number.isSafeInteger(size) || size < 0)
      fail('GIT_FAILED', 'Invalid Git batch blob metadata');
    result.set(oids[i], { size });
    // Account for framing as well as payload; git() still enforces OUTPUT_LIMIT.
    const frameSize = Buffer.byteLength(rows[i], 'ascii') + size + 2;
    if (size <= options.maxSize && size <= budget && wireSize + frameSize <= OUTPUT_LIMIT) {
      selected.push(oids[i]); budget -= size; wireSize += frameSize;
    }
  }
  if (!selected.length) return result;
  const output = (await git(root, ['cat-file', '--batch'], {
    input: input(selected), timeout: timeout(), limit: OUTPUT_LIMIT,
  })).stdout;
  let offset = 0;
  for (const oid of selected) {
    const blob = result.get(oid)!;
    const header = Buffer.from(`${oid} blob ${blob.size}\n`, 'ascii');
    if (!output.subarray(offset, offset + header.length).equals(header)) fail('GIT_FAILED', 'Invalid Git batch header');
    offset += header.length;
    // Payload is arbitrary bytes, including NUL/newlines/invalid UTF-8, not records.
    const end = offset + blob.size;
    if (end >= output.length || output[end] !== 10) fail('GIT_FAILED', 'Truncated Git batch payload');
    blob.bytes = output.subarray(offset, end);
    offset = end + 1;
  }
  if (offset !== output.length) fail('GIT_FAILED', 'Unexpected Git batch data');
  return result;
}
