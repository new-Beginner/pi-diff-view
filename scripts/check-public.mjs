import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || 'output/public');
const permittedRoots = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'src', 'tests', 'scripts', 'plugin']);
const secrets = [
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|pi_pat_[A-Za-z0-9_-]{20,})/,
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/,
];
const privateValues = [process.env.USERPROFILE, process.env.PI_SCRATCH_DIR, process.cwd()];
try { privateValues.push(execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' }).trim()); } catch {}
let count = 0;
const failures = [];
async function visit(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!relative && ['.git', 'node_modules'].includes(entry.name)) continue;
    if (relative === 'plugin' && entry.name === 'dist') continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!permittedRoots.has(name.split('/')[0])) failures.push(`${name}: outside publication allowlist`);
    if (entry.isSymbolicLink()) { failures.push(`${name}: symbolic link`); continue; }
    if (entry.isDirectory()) {
      if (/^(?:reference|docs|plugin\/docs)(?:\/|$)/.test(name)) failures.push(`${name}: private artifacts`);
      await visit(path.join(directory, entry.name), name);
    } else if (entry.isFile()) {
      count++;
      if (/^(?:\.env(?:\..*)?|.*\.(?:token|pem|key|piplug|jsonl|png|jpg|jpeg|webp)|credentials\.json|hosts\.yml)$/i.test(entry.name)) failures.push(`${name}: excluded private or binary file`);
      const text = await fs.readFile(path.join(directory, entry.name), 'utf8');
      if (text.includes('\0')) failures.push(`${name}: unexpected binary data`);
      secrets.forEach((pattern, index) => { if (pattern.test(text)) failures.push(`${name}: sensitive pattern ${index + 1}`); });
      if (privateValues.some(value => value && value.length > 6 && (text.includes(value) || text.includes(value.replaceAll('\\', '/')) || text.includes(value.replaceAll('\\', '\\\\'))))) failures.push(`${name}: private local identity or path`);
    }
  }
}
await visit(root);
console.log(`Public privacy preflight: ${count} files checked; ${failures.length} blockers.`);
failures.forEach(failure => console.error(failure));
if (failures.length) process.exit(1);
