import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.geojson', '.geojsonl', '.md', '.txt', '.xml']);

export function acceptedEncodings(header = '') {
  const values = new Map();
  for (const part of String(header).split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.find((value) => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    values.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  return ['br', 'gzip'].filter((name) => (values.get(name) ?? values.get('*') ?? 0) > 0)
    .sort((a, b) => (values.get(b) ?? values.get('*') ?? 0) - (values.get(a) ?? values.get('*') ?? 0));
}

/** Serve build-time compressed representations; never compress large assets per visitor. */
export async function serveStaticFile(req, res, filename, file, extension) {
  const compressible = TEXT.has(extension);
  let selected = filename, size = file.size, encoding;
  const accepted = compressible ? acceptedEncodings(req.headers['accept-encoding']) : [];
  for (const candidate of accepted) {
    try {
      const variant = `${filename}.${candidate === 'br' ? 'br' : 'gz'}`;
      const info = await stat(variant);
      if (!info.isFile()) continue;
      selected = variant; size = info.size; encoding = candidate; break;
    } catch { /* Dev/test files can lack precompressed representations. */ }
  }
  const streamingGzip = !encoding && accepted.includes('gzip');
  if (compressible) res.setHeader('Vary', 'Accept-Encoding');
  if (encoding || streamingGzip) res.setHeader('Content-Encoding', encoding || 'gzip');
  const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', file.mtime.toUTCString());
  const suppliedTag = String(req.headers['if-none-match'] || '');
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (suppliedTag.split(',').some((value) => value.trim() === etag || value.trim() === '*') ||
      (!suppliedTag && Number.isFinite(since) && Math.floor(file.mtimeMs / 1000) * 1000 <= since)) {
    res.writeHead(304); res.end(); return;
  }
  if (!streamingGzip) res.setHeader('Content-Length', size);
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
  if (streamingGzip) await pipeline(createReadStream(selected), createGzip(), res);
  else await pipeline(createReadStream(selected), res);
}
