import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.env.E2E_VIEW_DIR || 'plugin/views');
const fixtureRoot = path.resolve('tests/e2e');
const port = Number(process.env.E2E_PORT || 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const isFixture = relative === 'mock.js';
    const base = isFixture ? fixtureRoot : root;
    const target = path.resolve(base, relative);
    if (!target.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    let data = await fs.readFile(target);
    if (relative === 'index.html') {
      // Browser fixture only. This server never calls the actual plugin backend.
      data = Buffer.from(data.toString().replace('<head>', '<head><script src="/mock.js"></script>'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`Build plugin/views before serving E2E: ${error.message}`); }
}).listen(port, '127.0.0.1', () => console.log(`Mock review page http://127.0.0.1:${port} (built assets: ${root})`));
