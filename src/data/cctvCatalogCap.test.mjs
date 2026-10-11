import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import {
  CCTV_MAX_SOURCES_CEILING,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { CCTV_PROVIDER_PACKS, createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const pack = (name, count, prefix = name) => ({
  name,
  sources: Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    rank: i,
  })),
});

test('under the cap every pack is served whole, in merge order', () => {
  const { sources, packs } = allocateSourceCap(
    [pack('a', 3), pack('b', 2)],
    10,
  );
  assert.deepEqual(
    sources.map((s) => s.id),
    ['a-0', 'a-1', 'a-2', 'b-0', 'b-1'],
  );
  assert.deepEqual(packs, [
    { name: 'a', offered: 3, kept: 3 },
    { name: 'b', offered: 2, kept: 2 },
  ]);
});

test('over the cap the packs share it round-robin, and the last pack is never starved', () => {
  // The old positional slice kept the first N of [a..., b..., c...], which
  // deleted pack c entirely; the fair split thins every pack instead.
  const { sources, packs } = allocateSourceCap(
    [pack('a', 100), pack('b', 100), pack('c', 100)],
    9,
  );
  assert.equal(sources.length, 9);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [3, 3, 3],
  );
  // Each pack contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('c-')).map((s) => s.rank),
    [0, 1, 2],
  );
});

test('a duplicate inside one pack takes one slot, not two', () => {
  const dup = {
    name: 'file',
    sources: [{ id: 'x', v: 'old' }, { id: 'x', v: 'new' }, { id: 'y' }],
  };
  const { sources } = allocateSourceCap([dup], 2);
  assert.deepEqual(
    sources.map((s) => [s.id, s.v]),
    [
      ['x', 'new'],
      ['y', undefined],
    ],
  );
});

test('a short pack releases its turns to the others', () => {
  const { packs } = allocateSourceCap([pack('a', 2), pack('b', 50)], 10);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [2, 8],
  );
});

test('duplicate ids resolve last-pack-wins and count against the winning pack', () => {
  const live = {
    name: 'live',
    sources: [{ id: 'cam-1', label: 'live' }, { id: 'cam-2' }],
  };
  const override = {
    name: 'env',
    sources: [{ id: 'cam-1', label: 'override' }],
  };
  const { sources, packs } = allocateSourceCap([live, override], 10);
  assert.deepEqual(
    sources.map((s) => [s.id, s.label]),
    [
      ['cam-2', undefined],
      ['cam-1', 'override'],
    ],
  );
  assert.deepEqual(packs, [
    { name: 'live', offered: 1, kept: 1 },
    { name: 'env', offered: 1, kept: 1 },
  ]);
});

test('resolveCatalogCap bounds the env value and falls back to the default', () => {
  assert.equal(resolveCatalogCap(undefined), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('nonsense'), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('1'), 8);
  assert.equal(resolveCatalogCap('999999'), CCTV_MAX_SOURCES_CEILING);
  assert.equal(resolveCatalogCap('120.9'), 120);
});

test('the catalog applies the fair cap to approved providers end to end', async (t) => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_MAX_SOURCES = '9';
    for (const pack of CCTV_PROVIDER_PACKS) {
      const isDefault = ['fintraffic', 'nsw', 'calgary', 'vegvesen'].includes(pack.name);
      process.env[`CCTV_${pack.name.toUpperCase()}_ENABLED`] = isDefault ? '1' : '0';
      t.mock.method(pack, 'load', async () => Array.from({ length: 12 }, (_, i) => ({
        id: `${pack.name}-${i}`, name: `${pack.name} ${i}`,
        lat: 30 + i * 0.01, lon: -97,
      })));
    }
    const getSources = createCctvCatalog();
    const sources = await getSources();
    assert.equal(sources.length, 9);
    assert.deepEqual(
      sources.slice(0, 4).map((s) => s.pack),
      ['fintraffic', 'nsw', 'calgary', 'vegvesen'],
    );
    assert.deepEqual(
      getSources.trimmedPacks().map(({ pack, available, served }) => ({ pack, available, served })),
      [
        { pack: 'fintraffic', available: 12, served: 3 },
        { pack: 'nsw', available: 12, served: 2 },
        { pack: 'calgary', available: 12, served: 2 },
        { pack: 'vegvesen', available: 12, served: 2 },
      ],
    );
    const [trimmed] = getSources.trimmedPacks();
    assert.equal(trimmed.region.south, 30);
    assert.ok(Math.abs(trimmed.region.north - 30.11) < 1e-9);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('a pack trimmed to its nearest cameras reports how many it offered', async () => {
  const { prioritizeSources } =
    await import('../../server/providers/cctv/normalize.js');
  const cameras = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    lat: i,
    lon: 0,
  }));
  const kept = prioritizeSources(cameras, 2, [{ lat: 0, lon: 0 }]);
  assert.deepEqual(
    kept.map((camera) => camera.id),
    ['c0', 'c1'],
  );
  assert.equal(kept.available, 5);
  assert.deepEqual(kept.region, { west: 0, south: 0, east: 0, north: 4 });
});
