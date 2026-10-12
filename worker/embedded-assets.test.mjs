import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createEmbeddedAssets } from './embedded-assets.js';

test('mounted assets serve compressed or decoded bodies, HEAD and validators without swallowing portfolio routes', async () => {
  const raw = Buffer.from('approved globe document'); const compressed = gzipSync(raw);
  const serve = createEmbeddedAssets({ '/earth/index.html': { mime: 'text/html', etag: '"checked"', originalSize: raw.length, size: compressed.length, encoding: 'gzip', base64: compressed.toString('base64') } });
  const request = (path, init) => serve(new Request('https://example.test' + path, init));
  assert.equal(await request('/blog/'), null);
  assert.equal((await request('/earth')).headers.get('location'), '/earth/');
  assert.equal(await (await request('/earth/')).text(), raw.toString());
  const encoded = await request('/earth/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(encoded.headers.get('content-encoding'), 'gzip'); assert.deepEqual(Buffer.from(await encoded.arrayBuffer()), compressed);
  const head = await request('/earth/', { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String(raw.length));
  assert.equal((await request('/earth/', { headers: { 'If-None-Match': 'W/"checked"' } })).status, 304);
  assert.equal((await request('/earth/%2e%2e%2fprivate')).status, 404);
  assert.equal((await request('/earth/%ZZ')).status, 400);
  assert.equal((await request('/earth/', { method: 'POST' })).status, 405);
});

test('generated payload getters stay unevaluated on cold HEAD/304 and preserve exact encoded and identity GETs', async () => {
  const parent = path.resolve(tmpdir()), folder = await mkdtemp(path.join(parent, 'earth-lazy-assets-'));
  assert(path.resolve(folder).startsWith(parent + path.sep));
  const originals = {
    'index.html': Buffer.from('<!doctype html><title>Fixture Ω</title>\n'.repeat(100)),
    'app.js': Buffer.from('export const fixture = "🛰️";\n'.repeat(100)),
    'fixture.bin': Buffer.from([0, 255, 1, 254, 2, 253]),
  };
  try {
    await mkdir(path.join(folder, 'dist'));
    for (const [name, body] of Object.entries(originals)) await writeFile(path.join(folder, 'dist', name), body);
    const producer = fileURLToPath(new URL('../scripts/worker-assets.mjs', import.meta.url));
    const run = await promisify(execFile)(process.execPath, [producer], {
      cwd: folder, env: { ...process.env, EARTH_BASE_PATH: '/earth/' }, timeout: 10000, maxBuffer: 4096,
    });
    assert.equal(JSON.parse(run.stdout).assets, 3);
    const source = await readFile(path.join(folder, 'worker-dist', 'assets.js'), 'utf8');
    const { default: generated } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const reads = new Map();
    for (const [route, asset] of Object.entries(generated)) {
      const descriptor = Object.getOwnPropertyDescriptor(asset, 'base64');
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(Object.hasOwn(descriptor, 'value'), false);
      Object.defineProperty(asset, 'base64', { ...descriptor, get() {
        reads.set(route, (reads.get(route) || 0) + 1); return descriptor.get.call(this);
      } });
    }
    const serve = createEmbeddedAssets(generated);
    for (const [name, raw] of Object.entries(originals)) {
      const route = '/earth/' + name, asset = generated[route];
      const request = init => serve(new Request('https://example.test' + route, init));
      assert.equal(asset.etag, '"' + createHash('sha256').update(raw).digest('hex') + '"');
      const head = await request({ method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(head.headers.get('content-length'), String(asset.encoding ? asset.size : raw.length));
      assert.equal(head.headers.get('content-encoding'), asset.encoding);
      const unchanged = await request({ headers: { 'If-None-Match': asset.etag } });
      assert.equal(unchanged.status, 304); assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
      assert.equal(reads.get(route) || 0, 0, 'cold metadata must not evaluate the payload getter');
      const identity = await request();
      assert.deepEqual(Buffer.from(await identity.arrayBuffer()), raw);
      assert.equal(identity.headers.get('content-length'), String(raw.length));
      assert.equal(identity.headers.get('content-type'), asset.mime);
      assert.equal(identity.headers.get('etag'), asset.etag);
      const encoded = await request({ headers: { 'Accept-Encoding': 'gzip' } });
      assert.deepEqual(Buffer.from(await encoded.arrayBuffer()), asset.encoding ? gzipSync(raw, { level: 9 }) : raw);
      assert.equal(encoded.headers.get('content-encoding'), asset.encoding);
      assert.equal(reads.get(route), 1, 'warm GET must reuse the unchanged bounded decode cache');
    }
    assert.equal(generated['/earth/fixture.bin'].encoding, null);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
