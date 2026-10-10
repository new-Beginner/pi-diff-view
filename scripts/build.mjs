import { build } from 'esbuild';
import fs from 'node:fs/promises';
const common = { bundle: true, sourcemap: false, logLevel: 'info', target: 'es2022' };
await fs.mkdir('plugin/agent', { recursive: true });
await fs.mkdir('plugin/views', { recursive: true });
await fs.mkdir('plugin/renderer', { recursive: true });
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'plugin/main.js', platform: 'node', format: 'cjs', external: ['original-fs'] });
await build({ ...common, entryPoints: ['src/agent/capture.ts'], outfile: 'plugin/agent/index.mjs', platform: 'node', format: 'esm' });
await build({ ...common, entryPoints: ['src/view/index.tsx'], outfile: 'plugin/views/index.js', platform: 'browser', format: 'esm' });
// PI-Desktop 0.17.0 maps ONLY react/react-dom/react-dom/client, not react/jsx-runtime.
const renderer = await build({ ...common, entryPoints: ['src/renderer/index.tsx'], outfile: 'plugin/renderer/index.mjs', platform: 'browser', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', tsconfigRaw: { compilerOptions: { jsx: 'react' } }, metafile: true, external: ['react', 'react-dom', 'react-dom/client'] });
const hostModules = new Set(['react', 'react-dom', 'react-dom/client']);
for (const output of Object.values(renderer.metafile.outputs)) for (const imported of output.imports) {
  if (imported.external && !hostModules.has(imported.path)) throw new Error(`Renderer imports a module absent from the PI-Desktop 0.17.0 import map: ${imported.path}`);
}
await fs.copyFile('src/view/index.html', 'plugin/views/index.html');
console.log('Built offline plugin entry points for PI-Desktop 0.17.0');
await fs.mkdir('plugin/licenses', { recursive: true });
for (const name of ['diff', 'highlight.js', 'react', 'react-dom']) await fs.copyFile(`node_modules/${name}/LICENSE`, `plugin/licenses/${name}.txt`);
await fs.copyFile('LICENSE', 'plugin/LICENSE');
await fs.copyFile('README.md', 'plugin/README.md');
await fs.copyFile('THIRD_PARTY_NOTICES.md', 'plugin/THIRD_PARTY_NOTICES.md');
await fs.mkdir('plugin/docs', { recursive: true });
await fs.copyFile('docs/compatibility.md', 'plugin/docs/compatibility.md');
await fs.copyFile('docs/native-preflight.md', 'plugin/docs/native-preflight.md');
await fs.copyFile('docs/task-summary.md', 'plugin/docs/task-summary.md');
await fs.mkdir('plugin/docs/screenshots', { recursive: true });
for (const name of ['review-wide.png', 'review-narrow.png', 'task-summary-sidebar.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
try { await fs.copyFile('docs/verification.md', 'plugin/docs/verification.md'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
