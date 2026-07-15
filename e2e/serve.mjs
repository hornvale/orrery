// Serves ./dist under /orrery/ the way GitHub Pages does — sub-path and all.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const BASE = '/orrery/';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === BASE.slice(0, -1)) { res.writeHead(301, { location: BASE }); res.end(); return; }
  if (!url.pathname.startsWith(BASE)) { res.writeHead(404); res.end('outside base'); return; }
  const rel = url.pathname.slice(BASE.length) || 'index.html';
  const path = normalize(join('dist', rel));
  if (!path.startsWith(`dist${sep}`) && path !== 'dist') { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(4173, '127.0.0.1');
