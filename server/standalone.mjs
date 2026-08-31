// =====================================================================
// Standalone production server: serves the built `dist/` bundle plus the
// same PageRank API middleware the dev server mounts.
//
//     npm run build && npm start
//
// Uses only Node built-ins, so the project still has no runtime deps.
// =====================================================================

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApiMiddleware } from './api.mjs';
import { ensureAllBinaries } from './pagerank-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const api = createApiMiddleware();

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  // Resolve inside DIST and verify containment, so "../" cannot escape.
  const candidate = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  const resolved = path.resolve(candidate);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let filePath = resolved;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(DIST, 'index.html'); // SPA fallback
  }

  try {
    const data = await fsp.readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

await ensureAllBinaries().then((r) => {
  for (const [name, s] of Object.entries(r)) {
    if (!s.ok) console.error(`[pagerank] ${name}: ${s.error}`);
  }
});

http.createServer((req, res) => {
  api(req, res, () => serveStatic(req, res));
}).listen(PORT, () => {
  console.log(`PageRank Lab running at http://localhost:${PORT}`);
});
