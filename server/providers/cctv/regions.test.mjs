import test from 'node:test';
import assert from 'node:assert/strict';
import { cctvAreaQuery, cctvPackForId, cctvRegionIntersects } from './regions.js';

test('camera area queries require all rounded coordinates and a fixed radius before any work', () => {
  assert.deepEqual(cctvAreaQuery(new URLSearchParams()), { area: null });
  assert.deepEqual(cctvAreaQuery(new URLSearchParams('lat=50.85&lon=4.351&radiusKm=10')), { area: { lat: 50.85, lon: 4.351, radiusKm: 10 } });
  for (const query of ['lat=50', 'lat=50&lon=4', 'lat=50&lon=4&radiusKm=11', 'lat=91&lon=4&radiusKm=10',
    'lat=50&lon=181&radiusKm=10', 'lat=50.8501&lon=4&radiusKm=10', 'lat=5e1&lon=4&radiusKm=10',
    'lat=&lon=4&radiusKm=10', 'lat=50&lon=4&radiusKm=10&lat=51', 'lat=50&lon=4&radiusKm=10&url=https://example.com', 'foo=1']) {
    assert.ok(cctvAreaQuery(new URLSearchParams(query)).error, query);
  }
});

test('provider regions reject Brussels and separate Helsinki, Oslo, Sydney and Calgary', () => {
  for (const name of ['fintraffic', 'vegvesen', 'nsw', 'calgary', 'drivebc', 'tfl', 'ontario'])
    assert.equal(cctvRegionIntersects(name, { lat: 50.85, lon: 4.351, radiusKm: 10 }), false, name);
  assert.equal(cctvRegionIntersects('fintraffic', { lat: 60.17, lon: 24.938, radiusKm: 10 }), true);
  assert.equal(cctvRegionIntersects('vegvesen', { lat: 60.17, lon: 24.938, radiusKm: 10 }), false);
  assert.equal(cctvRegionIntersects('vegvesen', { lat: 59.914, lon: 10.752, radiusKm: 10 }), true);
  assert.equal(cctvRegionIntersects('fintraffic', { lat: 59.914, lon: 10.752, radiusKm: 10 }), false);
  assert.equal(cctvRegionIntersects('nsw', { lat: -33.869, lon: 151.209, radiusKm: 10 }), true);
  assert.equal(cctvRegionIntersects('calgary', { lat: 51.046, lon: -114.063, radiusKm: 10 }), true);
  // A nearby circle can intersect a provider even if its centre is outside.
  assert.equal(cctvRegionIntersects('calgary', { lat: 50.79, lon: -114.1, radiusKm: 10 }), true);
  assert.equal(cctvRegionIntersects('vegvesen', { lat: 70.1, lon: 29, radiusKm: 10 }), true);
  assert.equal(cctvRegionIntersects('nsw', { lat: 0, lon: 180, radiusKm: 250 }), false);
});

test('known camera prefixes resolve one provider and malformed or unknown IDs resolve none', () => {
  for (const [id, name] of [['fi-c0150301', 'fintraffic'], ['fintraffic-C0150301', 'fintraffic'], ['no-vegvesen-123', 'vegvesen'],
    ['calgary-86', 'calgary'], ['on-1', 'ontario'], ['tfl-00002.00865', 'tfl'], ['nsw-1', 'nsw'], ['drivebc-13', 'drivebc']]) {
    assert.equal(cctvPackForId(id), name);
  }
  for (const id of ['unknown', 'fi-', 'fi-a/b', 'fi-a\\b', 'fi-a\n', 'fi-' + 'a'.repeat(256)]) assert.equal(cctvPackForId(id), null);
});
