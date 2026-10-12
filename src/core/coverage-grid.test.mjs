import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageSector, coverageSectorAt, coverageDemandSectors } from './coverage-grid.js';

test('all coverage sectors partition the sphere and preserve pole/dateline membership', () => {
  let area = 0;
  for (let id = 1; id <= 120; ++id) {
    const s = coverageSector(id), b = s.bounds;
    assert.equal(coverageSectorAt({ lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 }), id);
    area += (b.east - b.west) / 360 * (Math.sin(b.north * Math.PI / 180) - Math.sin(b.south * Math.PI / 180)) / 2;
  }
  assert.ok(Math.abs(area - 1) < 1e-12);
  assert.equal(coverageSectorAt({ lon: 180, lat: 90 }), 109);
  assert.equal(coverageSectorAt({ lon: -180, lat: -90 }), 1);
  for (const lon of [0, -180, 180]) assert.equal(coverageSectorAt({ lon, lat: 0 }), coverageSectorAt({ lon, lat: -0 }));
  assert.equal(coverageSectorAt({ lon: null, lat: 0 }), null);
  assert.equal(coverageSectorAt({ lon: 181, lat: 0 }), null);
});
test('interest reveals only one coarse center sector and no sky/world diagnostic fallback', () => {
  const demand = { center: { lon: 4.3, lat: 50.8 }, tier: 'local' };
  assert.deepEqual(coverageDemandSectors(demand), [103]);
  assert.deepEqual(coverageDemandSectors({ ...demand, tier: 'world' }), []);
  assert.deepEqual(coverageDemandSectors({ ...demand, extraction: { reason: 'center-ray-misses-globe' } }), []);
});
