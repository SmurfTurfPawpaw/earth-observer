import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hostedProviders } from './hosted/providers.js';
import { createMiddlewareStack } from './hosted/middleware.js';
import { DOCUMENT_HEADERS } from './hosted/headers.js';
import { serveStaticFile } from './hosted/static-files.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.xml': 'application/xml', '.geojson': 'application/geo+json',
  '.geojsonl': 'application/x-ndjson', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.pbf': 'application/octet-stream', '.bin': 'application/octet-stream', '.terrain': 'application/octet-stream' };

export function createHostedServer({ distDir = path.join(ROOT, 'dist'), providers = hostedProviders(),
  trustedProxyAddresses = String(process.env.TRUSTED_PROXY_ADDRESSES || '').split(',').filter(Boolean),
} = {}) {
  const stack = createMiddlewareStack();
  const root = path.resolve(distDir);
  const buckets = new Map();
  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) res.setHeader(name, value);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"status":"ok"}'); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !(req.method === 'POST' && url.pathname === '/api/overpass')) {
          res.writeHead(405, { Allow: 'GET' }); res.end(); return;
        }
        let key = req.socket.remoteAddress;
        if (trustedProxyAddresses.includes(key)) {
          const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
          if (isIP(forwarded)) key = forwarded;
        }
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || now - bucket.at >= 60_000) {
          bucket = { at: now, count: 0 }; buckets.set(key, bucket);
        }
        if (++bucket.count > 240) {
          res.writeHead(429, { 'Retry-After': '60' }); res.end('Request limit reached'); return;
        }
        if (buckets.size > 10_000) {
          for (const [id, entry] of buckets) if (now - entry.at >= 60_000) buckets.delete(id);
          while (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
        }
        await stack.handle(req, res, (_req, response) => { response.writeHead(404); response.end(); });
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
      if (pathname.includes('\0') || pathname.includes('\\')) { res.writeHead(400); res.end(); return; }
      const relative = pathname === '/' ? '/index.html' : pathname;
      const filename = path.resolve(root, '.' + relative);
      if (!filename.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
      let file;
      try { file = await stat(filename); } catch { res.writeHead(404); res.end(); return; }
      if (!file.isFile()) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filename);
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', pathname.startsWith('/assets/') || /^\/cesium\/\d+\.\d+\.\d+\//.test(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
      if (ext === '.html') res.setHeader('Cache-Control', 'no-cache');
      await serveStaticFile(req, res, filename, file, ext);
    } catch (error) {
      if (res.destroyed) return;
      console.error('Request failed:', error.code || error.name);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Request failed"}');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const adapter = { middlewares: stack, httpServer: server };
  for (const plugin of providers) plugin.configureServer?.(adapter);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4174);
  const host = process.env.HOST || '0.0.0.0';
  const server = createHostedServer();
  server.listen(port, host, () => console.log(`Earth Observer listening on ${host}:${port}`));
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10_000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
