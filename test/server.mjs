/**
 * Minimal static server for the lab pages.
 *
 * Serves the repo-local node_modules next to the HTML so every engine loads from
 * the same origin (no CDN, no CORS surprises). Sends COOP/COEP so the
 * cross-origin-isolated bundles (duckdb threads, OPFS sync handles) are enabled.
 */
import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.PORT ?? 8765);
// 0.0.0.0 exposes the lab to the LAN. Only do this on a trusted network: the
// server has no auth and serves the whole lab directory.
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.parquet': 'application/octet-stream',
  '.csv': 'text/csv; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.data': 'application/octet-stream',
};

// TLS keeps `isSecureContext` true on a LAN IP, which OPFS and Web Locks both
// require. Without it, http://<lan-ip> silently loses navigator.storage.
const TLS = process.env.TLS === '1';
const tlsOptions = TLS
  ? {
      key: await readFile(path.join(ROOT, 'certs/key.pem')),
      cert: await readFile(path.join(ROOT, 'certs/cert.pem')),
    }
  : null;

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = path.join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
};

const server = TLS ? https.createServer(tlsOptions, handler) : http.createServer(handler);
const scheme = TLS ? 'https' : 'http';

server.listen(PORT, HOST, () => {
  console.log(`lab server on ${scheme}://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') console.log('LAN access enabled — no auth, trusted networks only');
});
