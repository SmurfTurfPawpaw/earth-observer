import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceProxy } from './intelligence.js';
import { createEonetSnapshot, EONET_SNAPSHOT_URL } from './eonet-snapshot.js';

const NOW = Date.parse('2026-10-11T10:00:00Z'), ISO = new Date(NOW).toISOString();
function endpoint(plugin) {
  let handler; plugin.configureServer({ middlewares: { use(path, callback) { assert.equal(path, '/api/intelligence'); handler = callback; } } });
  return async (url = '/?category=all') => {
    let status, body; await handler({ url, method: 'GET' }, { writeHead(value) { status = value; }, end(value) { body = value; } });
    return { status, payload: JSON.parse(body) };
  };
}
async function fixture(count = 2) {
  return createEonetSnapshot({ events: Array.from({ length: count }, (_, i) => ({ id: `EONET_${i + 1}`, title: `Named event ${i + 1}`,
    categories: [{ id: 'volcanoes' }], sources: [{ id: 'GDACS', url: `https://www.gdacs.org/report/${i + 1}` }], closed: null,
    geometry: [{ date: '2021-01-01T00:00:00Z', coordinates: [4, 50] }, { date: '2026-10-10T00:00:00Z', coordinates: [4, 50] }] })) },
    { retrievedAt: ISO, nowMs: NOW });
}
const news = () => ({ records: [], indexRecords: [], indexSource: { id: 'gdelt', generation: 'empty-fixture', expiresAt: new Date(NOW + 86400000).toISOString() },
  state: { id: 'gdelt', name: 'Synthetic scheduled news', status: 'ready', retrievedAt: ISO } });

test('the public default shares one EONET release read across visitors and searches its complete metadata locally', async () => {
  const snapshot = await fixture(60), gate = Promise.withResolvers(), calls = [];
  const read = endpoint(intelligenceProxy({ now: () => NOW, snapshotReader: async () => news(), fetchImpl: async (url) => {
    calls.push(url); await gate.promise;
    if (url === EONET_SNAPSHOT_URL) return Response.json(snapshot);
    if (url.startsWith('https://earthquake.usgs.gov/') || url.startsWith('https://www.gdacs.org/')) return Response.json({ features: [] });
    throw new Error('Unexpected acquisition');
  } }));
  assert.equal(calls.length, 0); const visitors = Array.from({ length: 12 }, () => read('/?category=disasters&q=volcanoes'));
  gate.resolve(); const results = await Promise.all(visitors);
  assert.equal(calls.filter((url) => url === EONET_SNAPSHOT_URL).length, 1); assert.equal(calls.length, 3);
  for (const { status, payload } of results) {
    assert.equal(status, 200); assert.equal(payload.indexRecords.length, 60); assert.equal(payload.reports.length, 60);
    assert.equal(payload.indexCoverage.maxRecords, 500);
    assert.equal(payload.sources.find((source) => source.id === 'eonet').status, 'ready');
    assert.match(payload.reports[0].matchReasons.join(' '), /EONET category/);
    assert.equal(payload.reports[0].sourceGeometryAt, '2026-10-10T00:00:00.000Z');
    assert.equal(payload.reports[0].observedAt, null); assert.equal(payload.reports[0].lat, undefined);
    assert.deepEqual(payload.reports[0].relatedReports, []);
  }
  await read('/?category=disasters&q=NASA'); assert.equal(calls.length, 3, 'local metadata terms cannot drive upstream acquisition');
});

test('country and non-disaster filters exclude EONET without withdrawing its acquired global generation', async () => {
  const snapshot = await fixture(), calls = [];
  const read = endpoint(intelligenceProxy({ now: () => NOW, snapshotReader: async () => news(), fetchImpl: async (url) => {
    calls.push(url); return Response.json(url === EONET_SNAPSHOT_URL ? snapshot : { features: [] });
  } }));
  const first = await read('/?category=all'); const source = first.payload.indexCoverage.sources.find((item) => item.id === 'eonet');
  assert.equal(first.payload.reports.length, 2);
  const country = await read('/?category=disasters&country=BE&q=volcanoes');
  assert.deepEqual(country.payload.reports, []); assert.equal(country.payload.sources.find((item) => item.id === 'eonet').status, 'not-applicable');
  assert.deepEqual(country.payload.indexCoverage.sources.find((item) => item.id === 'eonet'), source);
  assert.equal(country.payload.indexRecords.filter((item) => item.sourceId === 'eonet').length, 2);
  const economy = await read('/?category=economy'); assert.equal(economy.payload.sources.find((item) => item.id === 'eonet').status, 'not-applicable');
  await read('/?category=all'); assert.equal(calls.filter((url) => url === EONET_SNAPSHOT_URL).length, 1);
});

test('source retrieval age expires EONET independently of historical geometry and API response time', async () => {
  let clock = NOW, failing = false; const snapshot = await fixture();
  const read = endpoint(intelligenceProxy({ now: () => clock, snapshotReader: async () => news(), fetchImpl: async (url) => {
    if (url === EONET_SNAPSHOT_URL) return failing ? new Response('', { status: 503 }) : Response.json(snapshot);
    return Response.json({ features: [] });
  } }));
  const first = await read(); assert.equal(first.payload.reports.length, 2);
  failing = true; clock += 31 * 60000; const stale = await read();
  assert.equal(stale.payload.sources.find((item) => item.id === 'eonet').status, 'stale');
  assert.equal(stale.payload.reports[0].retrievedAt, ISO);
  clock = NOW + 86400001; const expired = await read();
  assert.deepEqual(expired.payload.reports, []); assert.equal(expired.payload.sources.find((item) => item.id === 'eonet').status, 'unavailable');
  assert.equal(expired.payload.indexRecords.some((item) => item.sourceId === 'eonet'), false);
});
