/** Serve an approved build snapshot with a bounded decode cache. No filesystem at runtime. */
export function createEmbeddedAssets(assets, { prefix = '/earth/', headers = {}, maxDecodedBytes = 8 * 1024 * 1024 } = {}) {
  const decoded = new Map(); let total = 0;
  function bytes(path, asset) {
    if (decoded.has(path)) { const value = decoded.get(path); decoded.delete(path); decoded.set(path, value); return value; }
    const binary = atob(asset.base64), value = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    while (decoded.size && total + value.byteLength > maxDecodedBytes) { const [key, older] = decoded.entries().next().value; total -= older.byteLength; decoded.delete(key); }
    if (value.byteLength <= maxDecodedBytes) { decoded.set(path, value); total += value.byteLength; }
    return value;
  }
  return async function assetsFetch(request) {
    const url = new URL(request.url);
    const reply = (status, text, extra = {}) => new Response(request.method === 'HEAD' ? null : text, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
    if (url.pathname === prefix.slice(0, -1)) return reply(308, '', { Location: prefix + url.search });
    if (!url.pathname.startsWith(prefix)) return null;
    if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return reply(400, 'Invalid request path.'); }
    if (/\\|\u0000/.test(path) || path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.'))) return reply(404, 'Not found.');
    if (path === prefix) path += 'index.html';
    const asset = Object.hasOwn(assets, path) && assets[path];
    if (!asset) return reply(404, 'Not found.');
    const gzip = /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s|,|$))[0-9.]+)?(?:\s*,|\s*$)/i.test(request.headers.get('Accept-Encoding') || '');
    const outHeaders = new Headers({ ...headers, 'Content-Type': asset.mime, ETag: asset.etag, Vary: 'Accept-Encoding',
      'Cache-Control': /(?:\/assets\/|\/cesium\/)/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if ((request.headers.get('If-None-Match') || '').split(',').some((value) => ['*', asset.etag].includes(value.trim().replace(/^W\//, '')))) return new Response(null, { status: 304, headers: outHeaders });
    if (asset.encoding && gzip) { outHeaders.set('Content-Encoding', asset.encoding); outHeaders.set('Content-Length', String(asset.size)); }
    else outHeaders.set('Content-Length', String(asset.originalSize));
    if (request.method === 'HEAD') return new Response(null, { headers: outHeaders });
    const compressed = bytes(path, asset);
    const body = asset.encoding && !gzip ? new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')) : compressed;
    return new Response(body, { headers: outHeaders, encodeBody: 'manual' });
  };
}
