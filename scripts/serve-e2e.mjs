import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
const componentRoot = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'review-component-'));
await build({ entryPoints: ['tests/e2e/review-harness.tsx'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: path.join(componentRoot, 'index.js') });
await fs.writeFile(path.join(componentRoot, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>ReviewApp component fixture · mocked backend, not production Panel</title><script src="/mock.js"></script><link rel="stylesheet" href="/review-component/index.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/review-component/index.js"></script></body></html>');
const root = path.resolve(process.env.E2E_VIEW_DIR || 'plugin/views');
const fixtureRoot = path.resolve('tests/e2e');
const port = Number(process.env.E2E_PORT || 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const isComponent = relative === 'review-component' || relative.startsWith('review-component/');
    const base = isComponent ? componentRoot : relative === 'mock.js' ? fixtureRoot : root;
    const asset = isComponent ? relative.slice('review-component'.length).replace(/^\/+/, '') || 'index.html' : relative;
    const target = path.resolve(base, asset);
    if (!target.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    let data = await fs.readFile(target);
    if (relative === 'index.html') {
      // Browser fixture only. This server never calls the actual plugin backend.
      data = Buffer.from(data.toString().replace('<head>', '<head><script src="/mock.js"></script>'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`Build plugin/views before serving E2E: ${error.message}`); }
}).listen(port, '127.0.0.1', () => console.log(`Mock review page http://127.0.0.1:${port} (built assets: ${root})`));
