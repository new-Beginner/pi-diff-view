// Browser-safe syntax policy; filesystem ancestry checks remain in path-policy.ts.
function deny(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
export function assertPathSyntax(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) deny('INVALID_PATH', 'Invalid file path');
  const portable = value.replace(/\\/g, '/');
  if (portable.split('/').includes('..')) deny('PATH_DENIED', 'Traversal paths cannot be captured');
  if (portable.startsWith('//') || portable.startsWith('/??/') || /^[a-z]:[^/]/i.test(portable) || portable.replace(/^[a-z]:\//i, '').includes(':')) deny('PATH_DENIED', 'UNC, device, drive-relative and alternate-stream paths are not reviewable');
}
/** A host scratch leaf is public tool evidence, not the surrounding host data directory. */
export function hostScratchRoot(value: string): string | undefined {
  const portable = value.replace(/\\/g, '/');
  if (!/^(?:[a-z]:\/|\/[^/])/i.test(portable)) return undefined;
  const match = /\/(?:\.pi-desktoooop|\.pi-desktop)\/data\/scratch\/[a-zA-Z0-9-]{1,80}(?=\/|$)/gi;
  let found: RegExpExecArray | null, root: string | undefined;
  while ((found = match.exec(portable))) root = portable.slice(0, found.index + found[0].length);
  return root;
}
export function assertPublicPath(value: string): void {
  assertPathSyntax(value);
  const portable = value.replace(/\\/g, '/'), parts = portable.split('/');
  for (const [index, part] of parts.entries()) {
    const s = part.toLowerCase();
    if (['.pi-desktoooop', '.pi-desktop'].includes(s) && /^(?:[a-z]:\/|\/[^/])/i.test(portable) && parts[index + 1]?.toLowerCase() === 'data' && parts[index + 2]?.toLowerCase() === 'scratch' && /^[a-zA-Z0-9-]{1,80}$/.test(parts[index + 3] ?? '')) continue;
    if (s === '..' || /[. ]$/.test(s) && s !== '.' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(s) || ['.git', '.ssh', '.aws', '.gnupg', '.gpg', '.npmrc', '.git-credentials', '.netrc', '_netrc', '.pi', '.claude', '.codex', '.pi-desktoooop', '.pi-desktop', '.pi-diff-view', 'node_modules'].includes(s) || s.startsWith('.env') || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) deny('PATH_DENIED', 'Credential, dependency, internal or escaping paths are not reviewable');
  }
}
