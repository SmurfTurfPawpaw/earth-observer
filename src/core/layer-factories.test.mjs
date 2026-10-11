import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftSource, createLayer, layerServiceRequirements, preloadLayer } from './layer-factories.js';
import * as aircraftNormalizers from '../sources/live/aircraft.js';

test('real selective module imports make no dataset or API requests and share engine groups', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Warm-up cannot fetch data'); };
  try {
    assert.equal(preloadLayer('flights'), preloadLayer('military'));
    await Promise.all([preloadLayer('flights'), preloadLayer('weather-radar'), preloadLayer('local-firms'), preloadLayer('local-datacenters')]);
    assert.equal(requests, 0);
    assert.deepEqual(layerServiceRequirements('flights'), ['render']);
    assert.deepEqual(layerServiceRequirements('military'), ['render']);
    assert.deepEqual(layerServiceRequirements('weather-radar'), ['weatherClock']);
    assert.deepEqual(layerServiceRequirements('recent-imagery'), ['render']);
    assert.deepEqual(layerServiceRequirements('local-firms'), []);
    assert.deepEqual(layerServiceRequirements('local-datacenters'), []);
    assert.deepEqual(layerServiceRequirements('local-dams'), []);
  } finally { globalThis.fetch = originalFetch; }
});

const NOW = 1791676800000;
const aircraft = { hex: 'abc123', lat: 50.85, lon: 4.35, seen_pos: 2, gs: 200, track: 90 };

test('public aircraft layers use bounded buffered motion and retain an explicit observed-only override', async () => {
  for (const id of ['flights', 'military']) {
    const layer = await createLayer(id, { services: {} });
    assert.equal(layer.getStats().predictionEnabled, true);
    assert.equal(layer.getStats().presentationDelayMs, 25000);
    assert.equal(layer.getStats().horizonMs, 5000);
    const observed = await createLayer(id, { services: {}, aircraftMotion: { predictionEnabled: false } });
    assert.equal(observed.getStats().predictionEnabled, false);
  }
});

async function withNow(run) {
  const original = Date.now;
  Date.now = () => NOW;
  try { await run(); } finally { Date.now = original; }
}

test('aircraft factory preserves valid source epochs even when cache metadata is older', async () => {
  await withNow(async () => {
    for (const upstreamNow of [(NOW - 5000) / 1000, NOW - 5000]) {
      let path;
      const source = createAircraftSource(async (url) => {
        path = url;
        return Response.json({ now: upstreamNow, ac: [aircraft] }, { headers: { 'x-feed-age-ms': '300000' } });
      }, false, aircraftNormalizers);
      const snapshot = await source.getSnapshot({ latitude: 50.85, longitude: 4.35, radiusKm: 10 });
      assert.equal(path, '/api/flights?lat=50.8500&lon=4.3500&radiusKm=10');
      assert.equal(snapshot.observedAtMs, NOW - 5000);
      assert.equal(snapshot.observedAtSource, 'source');
      assert.equal(snapshot.records[0].positionTimeMs, NOW - 7000);
      assert.equal(snapshot.records[0].positionTimeQuality, 'reported');
      assert.equal(snapshot.stale, true, 'Cache status remains separate from source position time');
    }
  });
});

test('aircraft factory receipt/cache fallbacks never qualify missing or invalid source timestamps', async () => {
  await withNow(async () => {
    for (const upstreamNow of [undefined, null, '', true, '1791676800', -1, Infinity, NOW + 11000]) {
      const source = createAircraftSource(async () => Response.json({ now: upstreamNow, ac: [aircraft] }, { headers: { 'x-feed-age-ms': '5000' } }), true, aircraftNormalizers);
      const snapshot = await source.getSnapshot();
      assert.equal(snapshot.observedAtMs, NOW - 5000);
      assert.equal(snapshot.observedAtSource, 'receipt');
      assert.equal(snapshot.records[0].positionTimeMs, null);
      assert.equal(snapshot.records[0].positionTimeQuality, 'unknown');
      assert.equal(snapshot.records[0].latitude, 50.85);
      assert.equal(snapshot.freshness, 'unknown');
    }
    const source = createAircraftSource(async () => Response.json({ now: NOW / 1000, ac: [{ ...aircraft, seen_pos: undefined }] }), false, aircraftNormalizers);
    const snapshot = await source.getSnapshot();
    assert.equal(snapshot.observedAtSource, 'source');
    assert.equal(snapshot.records[0].positionTimeQuality, 'unknown');
    const impossibleReceipt = createAircraftSource(async () => Response.json({ ac: [aircraft] }, { headers: { 'x-feed-age-ms': String(NOW + 1) } }), false, aircraftNormalizers);
    assert.equal((await impossibleReceipt.getSnapshot()).observedAtSource, 'unknown');
  });
});
