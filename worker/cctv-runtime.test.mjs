import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthRuntime } from './index.js';
import { FINTRAFFIC_STATIONS_URL } from '../server/providers/cctv/constants.js';

const request = (path) => new Request('https://example.com/earth/api/cctv' + path);
const station = { type: 'Feature', geometry: { type: 'Point', coordinates: [24.938, 60.17] },
  properties: { id: 'C01503', name: 'Fixture road', collectionStatus: 'GATHERING', presets: [{ id: 'C0150301', inCollection: true }] } };

test('actual default Worker runtime acquires no camera catalog for Brussels, health, invalid queries or unknown IDs', async () => {
  let calls = 0;
  const runtime = createEarthRuntime({ cache: null, fetchImpl: async () => { calls++; throw new Error('Unexpected upstream request'); } });
  try {
    const empty = await runtime.fetch(request('/sources?lat=50.85&lon=4.351&radiusKm=10'), {});
    assert.equal(empty.status, 200); assert.equal(empty.headers.get('cache-control'), 'no-store');
    const payload = await empty.json(); assert.equal(payload.coverage.status, 'unsupported'); assert.deepEqual(payload.sources, []);
    assert.equal((await runtime.fetch(request('/health'))).status, 200);
    assert.equal((await runtime.fetch(request('/sources?lat=50.85001&lon=4&radiusKm=10'))).status, 400);
    assert.equal((await runtime.fetch(request('/frame/unknown'))).status, 404); assert.equal(calls, 0);
  } finally { runtime.close(); }
});

test('Worker Helsinki catalog and cold frame paths use only Digitraffic and its registered image origin', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const runtime = createEarthRuntime({ cache: null, fetchImpl: async (url, options) => {
    calls.push(String(url)); assert.equal(options.redirect, 'manual');
    if (String(url) === FINTRAFFIC_STATIONS_URL) return Response.json({ features: [station] });
    assert.equal(String(url), 'https://weathercam.digitraffic.fi/C0150301.jpg');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  try {
    assert.equal((await runtime.fetch(request('/frame/fi-c0150301'))).status, 200);
    const payload = await (await runtime.fetch(request('/sources?lat=60.17&lon=24.938&radiusKm=10'))).json();
    assert.equal(payload.sources.length, 1); assert.deepEqual(payload.coverage.providers, ['fintraffic']);
    assert.equal((await runtime.fetch(request('/frame/fi-c0150301'))).status, 200);
    await runtime.fetch(request('/health')); await runtime.fetch(request('/sources?lat=60.18&lon=24.94&radiusKm=10'));
    assert.deepEqual(calls, [FINTRAFFIC_STATIONS_URL, 'https://weathercam.digitraffic.fi/C0150301.jpg']);
  } finally { runtime.close(); }
});
