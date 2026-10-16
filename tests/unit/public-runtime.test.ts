import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const script = '../../scripts/check-public-runtime.mjs';
const { runtimeViolations } = await import(script);
it.each([
  ['import(main)', 'dynamic import'],
  ['import("./host.js")', 'dynamic import'],
  ['eval(code)', 'dynamic execution'],
  ['new Function(code)', 'Function constructor'],
  ['globalThis.eval(code)', 'dynamic execution'],
  ['require(path)', 'nonliteral require'],
  ['const path = "resources/app.asar"', 'private host dependency'],
  ['const path = "review-changes/session"', 'private host dependency'],
])('rejects unsafe emitted runtime: %s', (code, reason) => {
  expect(runtimeViolations(code).some((error: string) => error.includes(reason))).toBe(true);
});
it('allows static imports, literal Node requires and non-executable comments/text', () => {
  expect(runtimeViolations('import React from "react"; const fs = require("node:fs"); // import(code)\nconst label="eval(code)";')).toEqual([]);
});
it('does not bundle test archives or private host dependencies in the real backend', async () => {
  const built = await build({ entryPoints: ['src/main.ts'], platform: 'node', format: 'cjs', bundle: true, write: false });
  expect(runtimeViolations(built.outputFiles[0].text, 'main.js')).toEqual([]);
  const source = await fs.readFile(path.resolve('src/main.ts'), 'utf8');
  expect(source).toContain('new HostHistoryImporter(store)');
  expect(source).not.toContain('native-host-build');
  expect(source).not.toContain('path.dirname(dataPath)');
});
