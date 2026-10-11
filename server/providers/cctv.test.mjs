import test from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from './cctv.js';
import { CCTV_PROVIDER_PACKS } from './cctv/catalog.js';

function requestFor(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(_path, middleware) { handler = middleware; } } });
  return async (url, method = 'GET') => {
    const response = {};
    await handler({ method, url }, { writeHead(status, headers) { Object.assign(response, { status, headers }); }, end(body) { response.body = body; } });
    return response;
  };
}
const onlyFinland = { CCTV_NSW_ENABLED: '0', CCTV_CALGARY_ENABLED: '0', CCTV_VEGVESEN_ENABLED: '0' };
const camera = { id: 'fi-c0150301', name: 'Fixture road camera', lat: 60.17, lon: 24.938,
  url: 'https://weathercam.digitraffic.fi/C0150301.jpg', license: 'Fintraffic / digitraffic.fi (CC BY 4.0)' };

test('invalid scoped catalogs and unknown frame paths fail before any provider acquisition', async (t) => {
  let calls = 0;
  for (const pack of CCTV_PROVIDER_PACKS) t.mock.method(pack, 'load', async () => { calls++; return [camera]; });
  const request = requestFor(cctvProxy({ env: {}, fetchImpl: async () => { throw new Error('Unexpected image fetch'); } }));
  for (const url of ['/sources?lat=50', '/sources?lat=50&lon=4&radiusKm=10&lon=5', '/sources?lat=50.85001&lon=4&radiusKm=10',
    '/sources?lat=50&lon=4&radiusKm=10&url=https://example.com']) assert.equal((await request(url)).status, 400, url);
  assert.equal((await request('/frame/%E0%A4%A')).status, 400);
  assert.equal((await request('/frame/unknown')).status, 404);
  assert.equal((await request('/frame/fi-a%2Fb')).status, 404);
  assert.equal((await request('/sources', 'POST')).status, 405); assert.equal(calls, 0);
});

test('scoped sources expose safe empty coverage without catalog URLs or unrelated pack loads', async (t) => {
  const calls = [];
  for (const pack of CCTV_PROVIDER_PACKS) t.mock.method(pack, 'load', async () => { calls.push(pack.name); return [camera]; });
  const request = requestFor(cctvProxy({ env: {} }));
  const empty = await request('/sources?lat=50.85&lon=4.351&radiusKm=10');
  assert.equal(empty.status, 200); assert.deepEqual(JSON.parse(empty.body).sources, []);
  assert.equal(JSON.parse(empty.body).coverage.status, 'unsupported'); assert.deepEqual(calls, []);
  const local = JSON.parse((await request('/sources?lat=60.17&lon=24.938&radiusKm=10')).body);
  assert.deepEqual(calls, ['fintraffic']); assert.equal(local.sources.length, 1);
  assert.equal(local.sources[0].frameUrl, '/api/cctv/frame/fi-c0150301');
  assert.equal(local.sources[0].url, undefined); assert.equal(local.sources[0].snapshotUrl, undefined);
  assert.equal(local.sources[0].license, camera.license);
});

test('cold frame and stream requests load one pack, coalesce stills, and health never refreshes catalogs', async (t) => {
  const calls = [], images = [];
  for (const pack of CCTV_PROVIDER_PACKS) t.mock.method(pack, 'load', async () => { calls.push(pack.name); return [camera]; });
  const request = requestFor(cctvProxy({ env: {}, fetchImpl: async (url, options) => {
    images.push(url); assert.equal(options.redirect, 'manual');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  } }));
  assert.deepEqual(JSON.parse((await request('/health')).body).cameras, []); assert.deepEqual(calls, []);
  const frames = await Promise.all([request('/frame/fi-c0150301'), request('/media/fi-c0150301')]);
  assert.deepEqual(frames.map((item) => item.status), [200, 200]); assert.deepEqual(calls, ['fintraffic']); assert.equal(images.length, 1);
  assert.equal((await request('/stream/fi-c0150301')).status, 200); assert.equal(images.length, 1);
  assert.equal(JSON.parse((await request('/health')).body).cameras.length, 1); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse((await request('/health?lat=50.85&lon=4.351&radiusKm=10')).body).cameras, []); assert.equal(calls.length, 1);
});

test('warm frame and health entries are immediately hidden on provider revocation', async (t) => {
  let packs = 0, images = 0;
  t.mock.method(CCTV_PROVIDER_PACKS[0], 'load', async () => { packs++; return [camera]; });
  const env = { ...onlyFinland };
  const request = requestFor(cctvProxy({ env, fetchImpl: async () => { images++; return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }); } }));
  assert.equal((await request('/frame/fi-c0150301')).status, 200);
  env.CCTV_FINTRAFFIC_ENABLED = '0';
  assert.equal((await request('/frame/fi-c0150301')).status, 404);
  assert.deepEqual(JSON.parse((await request('/health')).body).cameras, []);
  assert.equal(packs, 1); assert.equal(images, 1);
});
