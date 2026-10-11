import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
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
