// Optional BrowserPreview host: node tests/e2e/theme-server.mjs
// Compiles only the Panel fixture in memory. No project build, output assets or real Git operations.
import http from 'node:http';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
let bundle;
async function compile() {
  const result = await build({ entryPoints: ['src/view/index.tsx'], bundle: true, write: false, outfile: 'index.js', format: 'esm', platform: 'browser', target: 'es2022', define: { 'process.env.NODE_ENV': '"test"' } });
  bundle = Object.fromEntries(result.outputFiles.map(file => [file.path.endsWith('.css') ? '/index.css' : '/index.js', file.text]));
}
await compile();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let content, type = 'text/html';
    if (url.pathname === '/index.js' || url.pathname === '/index.css') {
      // Refresh from current sources for the manually reloaded preview, without touching built assets.
      if (url.pathname === '/index.js') await compile();
      content = bundle[url.pathname]; type = url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
    } else if (url.pathname === '/mock.js') {
      content = (await fs.readFile('tests/e2e/mock.js', 'utf8')) + '\n' + (await fs.readFile('tests/e2e/theme-mock.js', 'utf8')); type = 'text/javascript';
    } else if (url.pathname === '/') {
      await compile();
      content = (await fs.readFile('src/view/index.html', 'utf8')).replace('<title>', '<title>演示数据 · 模拟桥接 · ').replace('<body>', '<body><script src="/mock.js"></script>');
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(content);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(Number(process.env.THEME_PORT || 8791), '127.0.0.1', () => console.log('Theme demo ready at http://127.0.0.1:8791 (mocked backend only)'));
