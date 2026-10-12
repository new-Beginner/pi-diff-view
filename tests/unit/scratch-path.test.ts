import { describe, it, expect } from 'vitest';
import { assertPublicPath, hostScratchRoot } from '../../src/core/public-path';
import { hostEvidenceMessages } from '../../src/core/host-transcript';

describe('bounded host scratch path evidence', () => {
  it.each(['/home/user/.pi-desktoooop/data/scratch/session-1', 'D:/host/.pi-desktop/data/scratch/session-1'])('allows only the scratch leaf and safe descendants: %s', root => {
    expect(hostScratchRoot(`${root}/nested/file.txt`)).toBe(root);
    expect(() => assertPublicPath(root)).not.toThrow();
    expect(() => assertPublicPath(`${root}/nested/file.txt`)).not.toThrow();
    expect(() => assertPublicPath(root.replace(/\/scratch\/session-1$/, '/sessions/session-1.jsonl'))).toThrow();
    expect(() => assertPublicPath(root.replace(/\/session-1$/, ''))).toThrow();
    for (const child of ['.env', '.ssh/id_rsa', 'node_modules/private.js', '.pi/private', 'secret.pem', '../other/file.txt', 'a.txt:secret']) expect(() => assertPublicPath(`${root}/${child}`)).toThrow();
  });
  it('does not exempt relative host-private, UNC, malformed scratch or sensitive ancestor paths', () => {
    for (const value of ['.pi-desktop/data/scratch/s/file.txt', '//host/.pi-desktop/data/scratch/s/file.txt', '/home/.ssh/.pi-desktop/data/scratch/s/file.txt', '/host/.pi-desktop/data/scratch/bad.name/file.txt', '/host/.pi-desktop/data/plugins/private.txt']) expect(() => assertPublicPath(value)).toThrow();
    expect(() => assertPublicPath('D:\\host\\.pi-desktoooop\\data\\scratch\\session-1\\file.txt')).not.toThrow();
  });
  it('transfers actual scratch Write/Edit evidence while still stripping credentials and conversational prose', () => {
    const root = 'D:/host/.pi-desktoooop/data/scratch/session-1';
    const rows = hostEvidenceMessages([
      { id: 'w', role: 'tool', toolCallId: 'write', toolName: 'functions.Write', toolStatus: 'success', toolArgs: { file_path: `${root}/a.txt`, content: 'saved' } },
      { id: 'e', role: 'tool', toolCallId: 'edit', toolName: 'Edit', toolStatus: 'success', toolArgs: { path: `${root}/a.txt`, ops: 'PUT 1.=1:\n+edited' } },
      { id: 'p', role: 'tool', toolCallId: 'private', toolName: 'Write', toolArgs: { path: `${root}/.env`, content: 'secret' } },
      { id: 'a', role: 'assistant', content: 'private reply' },
    ]);
    expect(rows[0].blocks[0].args).toEqual({ path: `${root}/a.txt`, content: 'saved' });
    expect(rows[1].blocks[0].args.ops).toContain('+edited');
    expect(rows[2].blocks).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|private reply/);
  });
});
