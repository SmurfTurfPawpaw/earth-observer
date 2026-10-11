import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';

const prefix = process.env.EARTH_BASE_PATH || '/earth/';
if (!/^\/(?:[a-z0-9-]+\/)*$/.test(prefix)) throw new Error('Invalid EARTH_BASE_PATH');
const mime = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', geojson: 'application/geo+json', geojsonl: 'application/x-ndjson', jsonl: 'application/x-ndjson', xml: 'application/xml', txt: 'text/plain', md: 'text/plain', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', ktx2: 'image/ktx2', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream' };
const assets = {}; let rawBytes = 0, embeddedBytes = 0;
async function walk(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error('Unexpected hidden file or symlink in public build');
    const name = relative + entry.name, filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { await walk(filename, name + '/'); continue; }
    if (/\.(?:gz|br|map)$/.test(name)) continue;
    const body = await readFile(filename); rawBytes += body.length;
    if (body.length > 8 * 1024 * 1024 || rawBytes > 50 * 1024 * 1024) throw new Error('Public build exceeded Worker snapshot budget');
    const compressed = gzipSync(body, { level: 9 }), encoding = compressed.length < body.length ? 'gzip' : null;
    const bytes = encoding ? compressed : body; embeddedBytes += bytes.length;
    // vite-plugin-cesium includes the base path in its copied output directory.
    const nested = prefix.slice(1) + 'cesium/';
    const route = prefix !== '/' && name.startsWith(nested) ? '/' + name : prefix + name;
    if (assets[route]) throw new Error('Duplicate public asset route');
    assets[route] = { mime: mime[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream', originalSize: body.length,
      size: bytes.length, encoding, etag: '"' + createHash('sha256').update(body).digest('hex') + '"', base64: bytes.toString('base64') };
  }
}
await walk('dist');
if (!assets[prefix + 'index.html']) throw new Error('Missing application document');
await mkdir('worker-dist', { recursive: true });
await writeFile('worker-dist/assets.js', `// Generated only from public production build.\nexport default ${JSON.stringify(assets)};\n`);
console.log(JSON.stringify({ assets: Object.keys(assets).length, rawBytes, embeddedBytes, prefix }));
