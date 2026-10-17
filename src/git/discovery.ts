import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryInfo } from '../core/contracts';
import { assertPublicPath, canonical, fail, inside, safeResolve } from '../core/path-policy';
import { discoverRepository } from './repository';

export const SCAN_LIMITS = { directories: 2000, entries: 20000, depth: 6, repositories: 100 };
export function workspaceRoots(workspace: { path: string; roots?: (string | { path: string })[] } | null): string[] {
  return [...new Map((workspace ? [workspace.path, ...(workspace.roots ?? []).map(r => typeof r === 'string' ? r : r.path)] : []).map(root => [canonical(root), root])).values()];
}
/** Descendants are allowed only through real, public directories; never adopt a parent repository. */
export async function authorizedRepositoryPath(requested: string, allowedRoots: readonly string[]): Promise<string> {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) fail('INVALID_ROOT', 'Select an absolute project directory.');
  const target = path.resolve(requested);
  for (const allowed of allowedRoots) {
    const real = await fs.realpath(allowed).catch(() => undefined);
    if (!real) continue;
    // The host may explicitly authorize a directory alias. Descendant aliases still need ancestry checks.
    const base = inside(allowed, target) ? path.resolve(allowed) : real;
    if (!inside(base, target)) continue;
    const relative = path.relative(base, target);
    const resolved = relative ? await safeResolve(real, relative) : real;
    return fs.realpath(resolved).catch(() => fail('INVALID_ROOT', 'Project directory is unavailable.'));
  }
  fail('ROOT_DENIED', 'Repository is outside the authorized project directories.');
}

/** BFS with bounded directory, entry, depth and Git-process budgets. No symlinks/junctions. */
export async function scanRepositories(roots: readonly string[]): Promise<{ repositories: RepositoryInfo[]; repositoryNotice?: string }> {
  const repositories: RepositoryInfo[] = [], seen = new Set<string>();
  const queue: { root: string; directory: string; depth: number }[] = [];
  let truncated = false, unavailable = false, entries = 0, gitCount = 0;
  for (const root of roots) {
    try { const real = await fs.realpath(root); queue.push({ root: real, directory: real, depth: 0 }); }
    catch { repositories.push({ root, name: path.basename(root), git: false }); unavailable = true; }
  }
  for (let index = 0; index < queue.length; index++) {
    if (seen.size >= SCAN_LIMITS.directories || entries >= SCAN_LIMITS.entries || gitCount >= SCAN_LIMITS.repositories) { truncated = true; break; }
    const item = queue[index], key = canonical(item.directory);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (item.depth) await safeResolve(item.root, path.relative(item.root, item.directory));
      const marker = await fs.lstat(path.join(item.directory, '.git')).catch(() => undefined);
      if (item.depth === 0 || (marker && !marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory()))) {
        const repo = await discoverRepository(item.directory);
        if (repo.git || item.depth === 0) repositories.push(repo);
        if (repo.git) gitCount++;
      }
      const children: string[] = [];
      const directory = await fs.opendir(item.directory);
      for await (const entry of directory) {
        if (++entries > SCAN_LIMITS.entries) { truncated = true; break; }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try { assertPublicPath(entry.name); } catch { continue; }
        if (['.workflow', '.agents', '.cache', 'dist', 'build', 'vendor', '.venv', 'venv'].includes(entry.name.toLowerCase())) continue;
        if (item.depth >= SCAN_LIMITS.depth) { truncated = true; continue; }
        if (queue.length + children.length >= SCAN_LIMITS.directories) { truncated = true; continue; }
        children.push(entry.name);
      }
      for (const name of children.sort()) queue.push({ root: item.root, directory: path.join(item.directory, name), depth: item.depth + 1 });
    } catch { unavailable = true; }
  }
  return { repositories, repositoryNotice: [truncated ? '仓库扫描达到上限（6 层、2000 个目录、20000 个目录项或 100 个仓库）；可将更小的目录设为工作区继续管理。' : '', unavailable ? '部分目录不可访问，列表可能不完整。' : ''].filter(Boolean).join(' ') || undefined };
}
