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
const legacyFetch = (read) => async (url, options) => url.startsWith('/api/aircraft/observations')
  ? Response.json({ prepared: false, available: false, code: 'not-configured' }, { status: 503 }) : read(url, options);
const preparedPayload = () => ({ schemaVersion: 1, source: 'adsb.lol', prepared: true, delivery: 'prepared-aircraft-observations',
  observedAtMs: NOW, observedAtSource: 'source', collectedAt: new Date(NOW).toISOString(), stale: false, freshness: 'current',
  records: [{ id: 'abc123', latitude: 50.85, longitude: 4.35, positionTimeMs: NOW, positionTimeQuality: 'reported', speedMps: 100, courseDeg: 90, ellipsoidAltitudeM: 1200 }],
  history: [{ id: 'abc123', latitude: 50.85, longitude: 4.34, positionTimeMs: NOW - 30000, positionTimeQuality: 'reported', speedMps: 100, courseDeg: 90, ellipsoidAltitudeM: 1200 }],
  coverageScopes: [{ id: 'brussels', type: 'area', latitude: 50.85, longitude: 4.35, radiusKm: 250 }], coverage: 'Recorded Brussels area' });

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
      const source = createAircraftSource(legacyFetch(async (url) => {
        path = url;
        return Response.json({ now: upstreamNow, ac: [aircraft] }, { headers: { 'x-feed-age-ms': '300000' } });
      }), false, aircraftNormalizers);
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
      const source = createAircraftSource(legacyFetch(async () => Response.json({ now: upstreamNow, ac: [aircraft] }, { headers: { 'x-feed-age-ms': '5000' } })), true, aircraftNormalizers);
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

test('prepared source observations are preferred, preserve both dates and revalidate only when invalidated', async () => {
  await withNow(async () => {
    const calls = [], controller = new AbortController();
    const source = createAircraftSource(async (url, init) => { calls.push({ url, init }); return Response.json(preparedPayload()); }, false, aircraftNormalizers);
    const query = { latitude: 50.85, longitude: 4.35, radiusKm: 10 };
    const snapshot = await source.getSnapshot(query, { signal: controller.signal, revalidate: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/aircraft/observations?lat=50.8500&lon=4.3500&radiusKm=10');
    assert.equal(calls[0].init.signal, controller.signal); assert.equal(calls[0].init.cache, 'no-cache');
    assert.equal(calls[0].init.headers['Cache-Control'], 'no-cache');
    assert.equal(snapshot.prepared, true); assert.equal(snapshot.observedAtMs, NOW); assert.equal(snapshot.records[0].positionTimeMs, NOW);
    assert.equal(snapshot.history[0].positionTimeMs, NOW - 30000); assert.equal(snapshot.complete, false);
    await source.getSnapshot({ latitude: 50.85, longitude: 4.35 });
    assert.match(calls[1].url, /radiusKm=50$/); assert.equal(calls[1].init.cache, undefined);
    const military = createAircraftSource(async (url) => { assert.equal(url, '/api/aircraft/observations?military=1'); return Response.json(preparedPayload()); }, true, aircraftNormalizers);
    assert.equal((await military.getSnapshot()).prepared, true);
  });
});

test('only explicit prepared unavailability permits legacy fallback, and cancellation prevents the fallback request', async () => {
  await withNow(async () => {
    for (const code of ['not-configured', 'unavailable', 'not-covered']) {
      const calls = [];
      const source = createAircraftSource(async (url) => {
        calls.push(url);
        return url.startsWith('/api/aircraft/observations')
          ? Response.json({ prepared: false, available: false, code }, { status: 503 })
          : Response.json({ now: NOW / 1000, ac: [aircraft] });
      }, false, aircraftNormalizers);
      const snapshot = await source.getSnapshot({ latitude: 50.85, longitude: 4.35 });
      assert.equal(snapshot.records.length, 1);
      assert.equal(calls.length, 2); assert.equal(calls[1], '/api/flights?lat=50.8500&lon=4.3500&radiusKm=50');
      assert.match(snapshot.coverage, /within 50km/);
    }
    for (const response of [Response.json({ message: 'Forbidden' }, { status: 403 }), Response.json({ message: 'Unavailable' }, { status: 503 }), Response.json({ schemaVersion: 1 })]) {
      let calls = 0; const source = createAircraftSource(async () => { calls++; return response; }, true, aircraftNormalizers);
      await assert.rejects(source.getSnapshot()); assert.equal(calls, 1);
    }
    const controller = new AbortController(); let calls = 0;
    const cancelled = createAircraftSource(async () => {
      calls++; controller.abort(); return Response.json({ prepared: false, available: false, code: 'unavailable' }, { status: 503 });
    }, true, aircraftNormalizers);
    await assert.rejects(cancelled.getSnapshot({}, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
  });
});

test('prepared browser cache freshness is separate from its original observations and the source enforces its payload bound', async () => {
  await withNow(async () => {
    const source = createAircraftSource(async () => Response.json(preparedPayload(), { headers: { 'x-feed-cache': 'STALE', 'x-browser-cache': 'OFFLINE' } }), true, aircraftNormalizers);
    const cached = await source.getSnapshot();
    assert.equal(cached.stale, true); assert.equal(cached.browserCache, 'OFFLINE'); assert.equal(cached.observedAtMs, NOW);
    assert.equal(cached.records[0].positionTimeMs, NOW); assert.equal(cached.history[0].positionTimeMs, NOW - 30000);
    let calls = 0;
    const large = createAircraftSource(async () => { calls++; return new Response('{}'.padEnd(2 * 1024 * 1024 + 1)); }, true, aircraftNormalizers);
    await assert.rejects(large.getSnapshot(), /bounded payload/); assert.equal(calls, 1);
  });
});
