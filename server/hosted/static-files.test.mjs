import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createHostedServer } from '../index.js';
import { acceptedEncodings } from './static-files.js';

test('encoding negotiation honors exclusions, preferences and wildcards', () => {
  assert.deepEqual(acceptedEncodings('br, gzip'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('br;q=0, gzip'), ['gzip']);
  assert.deepEqual(acceptedEncodings('gzip;q=0.8, br;q=0.4'), ['gzip', 'br']);
  assert.deepEqual(acceptedEncodings('*;q=1, gzip;q=0'), ['br']);
  assert.deepEqual(acceptedEncodings('gzip;q=bad, br;q=0'), []);
});

test('large JSON Lines and engine files use precompression, correct HEAD and conditional caching', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'earth-static-'));
  const server = createHostedServer({ distDir: root, providers: [] });
  try {
    await mkdir(path.join(root, 'assets'));
    await mkdir(path.join(root, 'cesium', '1.138.0'), { recursive: true });
    const payload = '{"name":"A real mapped location"}\n'.repeat(100);
    const gz = gzipSync(payload), br = brotliCompressSync(payload);
    const filename = path.join(root, 'assets', 'points-a1b2.geojsonl');
    await writeFile(filename, payload); await writeFile(filename + '.gz', gz); await writeFile(filename + '.br', br);
    await writeFile(path.join(root, 'cesium', '1.138.0', 'Cesium.js'), '/* engine */');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/assets/points-a1b2.geojsonl`;
    const compressed = await fetch(url, { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(compressed.headers.get('content-encoding'), 'br');
    assert.equal(Number(compressed.headers.get('content-length')), br.length);
    assert.equal(await compressed.text(), payload);
    assert.match(compressed.headers.get('cache-control'), /immutable/);
    const head = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(head.headers.get('content-encoding'), 'gzip');
    assert.equal(Number(head.headers.get('content-length')), gz.length);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(url, { headers: { 'If-None-Match': compressed.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(url, { headers: { 'If-Modified-Since': compressed.headers.get('last-modified') } })).status, 304);
    const identity = await fetch(url, { headers: { 'Accept-Encoding': 'br;q=0,gzip;q=0' } });
    assert.equal(identity.headers.get('content-encoding'), null); assert.equal(await identity.text(), payload);
    const engine = await fetch(url.replace('/assets/points-a1b2.geojsonl', '/cesium/1.138.0/Cesium.js'));
    assert.match(engine.headers.get('cache-control'), /immutable/);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
