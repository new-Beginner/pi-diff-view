import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Publish a fresh, allowlisted snapshot, never the local repository history.
const root = process.cwd();
const destination = path.join(root, 'output', 'public');
try { await fs.lstat(destination); throw new Error('output/public already exists; inspect it before preparing another release'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const rootFiles = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts']);
const runtimeFiles = new Set(['manifest.json', 'package.json', 'main.js', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'agent/index.mjs', 'renderer/index.mjs', 'views/index.html', 'views/index.js', 'views/index.css', 'licenses/diff.txt', 'licenses/highlight.js.txt', 'licenses/react.txt', 'licenses/react-dom.txt']);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
files.push('scripts/prepare-public.mjs', 'scripts/check-public.mjs');
const selected = [...new Set(files)].filter(file => rootFiles.has(file) || (/^(src|tests)\//.test(file) && /\.(?:ts|tsx|js|mjs|css|html)$/.test(file)) || /^scripts\/(?:build|serve-e2e|prepare-public|check-public)\.mjs$/.test(file) || (file.startsWith('plugin/') && runtimeFiles.has(file.slice(7)))).sort();
for (const required of [...rootFiles, ...[...runtimeFiles].map(file => `plugin/${file}`)]) if (!selected.includes(required)) throw new Error(`Missing required public file: ${required}`);
for (const file of selected) {
  if (file.split('/').includes('..') || path.isAbsolute(file)) throw new Error(`Unsafe path: ${file}`);
  const source = path.join(root, file);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular public file: ${file}`);
  const target = path.join(destination, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
console.log(`Prepared ${selected.length} allowlisted public files, including ${runtimeFiles.size} runtime files. No Git history, reports, screenshots, references, credentials or local data copied.`);
