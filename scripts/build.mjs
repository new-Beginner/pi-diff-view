import { build } from 'esbuild';
import fs from 'node:fs/promises';
const common = { bundle: true, sourcemap: false, logLevel: 'info', target: 'es2022' };
await fs.mkdir('plugin/agent', { recursive: true });
await fs.mkdir('plugin/views', { recursive: true });
await fs.mkdir('plugin/renderer', { recursive: true });
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'plugin/main.js', platform: 'node', format: 'cjs', external: ['original-fs'] });
await build({ ...common, entryPoints: ['src/agent/capture.ts'], outfile: 'plugin/agent/index.mjs', platform: 'node', format: 'esm' });
await build({ ...common, entryPoints: ['src/view/index.tsx'], outfile: 'plugin/views/index.js', platform: 'browser', format: 'esm', minify: true });
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
await fs.copyFile('docs/performance.md', 'plugin/docs/performance.md');
await fs.copyFile('docs/running-changes.md', 'plugin/docs/running-changes.md');
await fs.mkdir('plugin/docs/screenshots', { recursive: true });
for (const name of ['review-wide.png', 'review-narrow.png', 'task-summary-sidebar.png', 'running-pill-1100-light.png', 'running-pill-1100-dark.png', 'running-pill-360-light.png', 'running-pill-360-dark.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
try { await fs.copyFile('docs/verification.md', 'plugin/docs/verification.md'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.copyFile('docs/verification-1.3.0.md', 'plugin/docs/verification-1.3.0.md');
await fs.copyFile('docs/verification-1.3.1.md', 'plugin/docs/verification-1.3.1.md');
await fs.copyFile('docs/verification-1.3.2.md', 'plugin/docs/verification-1.3.2.md');
await fs.copyFile('docs/verification-1.3.3.md', 'plugin/docs/verification-1.3.3.md');
await fs.copyFile('docs/verification-1.3.5.md', 'plugin/docs/verification-1.3.5.md');
for (const width of [360, 900]) await fs.copyFile(`docs/screenshots/unknown-card-1.3.5-${width}.png`, `plugin/docs/screenshots/unknown-card-1.3.5-${width}.png`);
for (const name of await fs.readdir('docs/screenshots')) {
  if (/^(?:theme-(?:session|git|confirm)-(?:360|600|1100)-(?:light|dark)|running-pill-600-(?:light|dark))\.png$/.test(name)) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
}
await fs.copyFile('docs/verification-1.4.0.md', 'plugin/docs/verification-1.4.0.md');
await fs.copyFile('docs/verification-1.4.1.md', 'plugin/docs/verification-1.4.1.md');
await fs.copyFile('docs/verification-1.4.2.md', 'plugin/docs/verification-1.4.2.md');
await fs.copyFile('docs/verification-1.4.3.md', 'plugin/docs/verification-1.4.3.md');
await fs.copyFile('docs/verification-1.4.4.md', 'plugin/docs/verification-1.4.4.md');
for (const name of ['360-light', '600-dark']) await fs.copyFile(`docs/screenshots/git-1.4.4-${name}.png`, `plugin/docs/screenshots/git-1.4.4-${name}.png`);
await fs.copyFile('docs/verification-1.4.5.md', 'plugin/docs/verification-1.4.5.md');
for (const name of ['360-light', '600-dark']) await fs.copyFile(`docs/screenshots/git-1.4.5-${name}.png`, `plugin/docs/screenshots/git-1.4.5-${name}.png`);
await fs.copyFile('docs/verification-1.4.6.md', 'plugin/docs/verification-1.4.6.md');
await fs.copyFile('docs/verification-1.4.7.md', 'plugin/docs/verification-1.4.7.md');
await fs.copyFile('docs/file-open-performance-1.4.7.json', 'plugin/docs/file-open-performance-1.4.7.json');
await fs.copyFile('docs/verification-1.4.8.md', 'plugin/docs/verification-1.4.8.md');
await fs.copyFile('docs/verification-1.4.9.md', 'plugin/docs/verification-1.4.9.md');
for (const name of ['ui-1.4.9-summary-sidebar.png', 'ui-1.4.9-host-fold.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
await fs.copyFile('docs/verification-1.4.10.md', 'plugin/docs/verification-1.4.10.md');
for (const name of ['card-1.4.10-expanded-light.png', 'card-1.4.10-expanded-narrow.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
await fs.copyFile('docs/verification-1.4.11.md', 'plugin/docs/verification-1.4.11.md');
await fs.copyFile('docs/verification-1.4.12.md', 'plugin/docs/verification-1.4.12.md');
for (const name of ['card-1.4.12-expanded-light.png', 'card-1.4.12-expanded-narrow.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
await fs.copyFile('docs/verification-1.4.13.md', 'plugin/docs/verification-1.4.13.md');
for (const name of ['card-1.4.13-directory-light.png', 'card-1.4.13-directory-narrow.png', 'card-1.4.13-expanded-light.png', 'card-1.4.13-expanded-narrow.png']) await fs.copyFile(`docs/screenshots/${name}`, `plugin/docs/screenshots/${name}`);
