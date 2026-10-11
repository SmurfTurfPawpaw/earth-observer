import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransitRecords, createObservedTransitLayer } from './transit.js';

const feed = { id: 'approved', name: 'Approved agency', region: 'Example', defaultMode: 'bus',
  center: { lat: 0, lon: 0 }, loadRadiusKm: 50, attribution: 'Approved agency', license: 'Open license', licenseUrl: 'https://example.org/license' };

test('transit admits actual coordinates, labels borrowed timestamps and rejects old fixes', () => {
  const now = Date.now();
  const snapshot = { fetchedAt: now - 1000, vehicles: [
    { id: 'real', lat: 0.1, lon: 0.2, timestamp: (now - 5000) / 1000, timestampSource: 'vehicle' },
    { id: 'feed-time', lat: 0.2, lon: 0.3 },
    { id: 'invalid', lat: null, lon: 2 },
    { id: 'old', lat: 0, lon: 0, timestamp: (now - 700000) / 1000 },
  ] };
  const records = normalizeTransitRecords(feed, snapshot, now);
  assert.equal(records.length, 2);
  assert.equal(records[0].lat, 0.1);
  assert.equal(records[1].observedAt, snapshot.fetchedAt);
  assert.equal(records[1].timestampSource, 'fetch');
});

test('transit points stay at reported positions and report stale fallback without changing their time', async () => {
  const sources = new Set(), credits = new Set();
  const viewer = { dataSources: { add: (source) => sources.add(source), remove: (source) => sources.delete(source) },
    camera: { positionCartographic: { latitude: 0, longitude: 0, height: 50000 } },
    scene: { requestRender() {}, frameState: { creditDisplay: { addStaticCredit: (credit) => credits.add(credit), removeStaticCredit: (credit) => credits.delete(credit) } } },
    isDestroyed: () => false };
  let fail = false;
  const now = Date.now();
  const snapshot = { fetchedAt: now - 1000, feedTimestamp: (now - 3000) / 1000,
    vehicles: [{ id: 'bus', lat: 0.1, lon: 0.2, timestamp: (now - 5000) / 1000, timestampSource: 'vehicle', routeId: '1' }] };
  const layer = createObservedTransitLayer({ catalog: [feed], fetchImpl: async (url) => {
    assert.equal(url, '/api/transit/vehicles/approved');
    if (fail) throw new Error('Offline');
    return { ok: true, headers: new Headers({ 'x-transit-contact': String(now) }), json: async () => snapshot };
  } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const source = [...sources][0], first = source.entities.values[0];
  assert.equal(first.position.isConstant, true);
  assert.equal(first.properties.timestampSource.getValue(), 'Vehicle report');
  const position = first.position.getValue();
  assert.equal(layer.getStats().count, 1);
  assert.equal(credits.size, 1);
  fail = true; await layer.update(viewer);
  const fallback = source.entities.values[0];
  assert.deepEqual(fallback.position.getValue(), position);
  assert.equal(layer.getStats().observedAtMs, snapshot.feedTimestamp * 1000);
  assert.equal(layer.getStats().stale, true);
  assert.equal(layer.getStats().degraded, true);
  layer.disable(); assert.equal(credits.size, 0);
  layer.destroy(); assert.equal(sources.size, 0);
});
