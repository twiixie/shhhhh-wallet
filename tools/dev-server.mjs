// Local preview: http://127.0.0.1:8362 serves ./dist and proxies /api/sp-index to shhhhh.site. This Mac only.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const PORT = 8362, DIST = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
http.createServer(async (req, res) => {
  if (!['127.0.0.1:' + PORT, 'localhost:' + PORT].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/sp-index') {
    try {
      const r = await fetch('https://shhhhh.site' + url.pathname + url.search);
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': r.headers.get('cache-control') || 'no-store' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); return res.end('{"error":"upstream"}'); }
  }
  const file = path.join(DIST, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^\/+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`shhhhh wallet preview: http://127.0.0.1:${PORT}`));
