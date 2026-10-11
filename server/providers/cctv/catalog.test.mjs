import test from 'node:test';
import assert from 'node:assert/strict';
import { CCTV_PROVIDER_PACKS, createCctvCatalog } from './catalog.js';
import { CCTV_SOURCE_CACHE_MS, CCTV_MAX_SOURCES_CEILING } from './constants.js';
import { prioritizeSources } from './normalize.js';

const brussels = { lat: 50.85, lon: 4.351, radiusKm: 10 };
const helsinki = { lat: 60.17, lon: 24.938, radiusKm: 10 };
const oslo = { lat: 59.914, lon: 10.752, radiusKm: 10 };
const camera = (id, lat = helsinki.lat, lon = helsinki.lon) => ({ id, lat, lon, name: id });
function mockPacks(t, load) {
  for (const pack of CCTV_PROVIDER_PACKS) t.mock.method(pack, 'load', (options) => load(pack.name, options));
}

test('a cold Brussels catalog skips every provider and returns honest zero coverage', async (t) => {
  let calls = 0;
  mockPacks(t, async () => { calls++; throw new Error('No camera provider should be selected'); });
  const sources = createCctvCatalog({ env: {} });
  const result = await sources.getCatalog(brussels);
  assert.equal(calls, 0); assert.deepEqual(result.sources, []); assert.deepEqual(result.providers, []);
  assert.equal(result.coverage.status, 'unsupported'); assert.match(result.coverage.note, /No reviewed camera provider/);
});

test('overlapping local and unscoped requests share per-pack refreshes and subsequent areas reuse the same pack', async (t) => {
  const calls = [], releases = new Map();
  mockPacks(t, (name, { retainAll }) => {
    assert.equal(retainAll, true); calls.push(name);
    return new Promise((resolve) => releases.set(name, resolve));
  });
  const getSources = createCctvCatalog({ env: {} });
  const local = getSources(helsinki), global = getSources(), anotherLocal = getSources({ ...helsinki, lat: 60.18 });
  assert.deepEqual(calls, ['fintraffic', 'nsw', 'calgary', 'vegvesen']);
  for (const [name, resolve] of releases) resolve([camera(`${name}-1`)]);
  assert.equal((await local).length, 1); assert.equal((await anotherLocal).length, 1); assert.equal((await global).length, 4);
  await getSources(oslo); assert.equal(calls.length, 4);
});

test('local filtering happens before pack and catalog caps, retaining cameras far from fixed city anchors', async (t) => {
  const farNorth = { lat: 69.9, lon: 27, radiusKm: 10 };
  const records = [...Array.from({ length: 20 }, (_, i) => camera(`fi-south${i}`)), camera('fi-north', 69.9, 27)];
  mockPacks(t, async (name, options) => name === 'fintraffic' ? prioritizeSources(records, 8, [helsinki], options) : []);
  const getSources = createCctvCatalog({ env: { CCTV_VEGVESEN_ENABLED: '0' } });
  assert.equal((await getSources()).length, 8);
  const local = await getSources.getCatalog(farNorth);
  assert.deepEqual(local.sources.map((item) => item.id), ['fi-north']);
  assert.equal(local.coverage.status, 'ready'); assert.equal(local.providers[0].matched, 1);
  assert.equal((await getSources.getById('fi-north')).id, 'fi-north', 'A locally admitted camera can serve its frame despite the global cap');
});

test('each provider preserves its own last-good catalog on failure and retries at the bounded cadence', async (t) => {
  let clock = 1000, fail = false;
  const calls = new Map();
  mockPacks(t, async (name) => {
    calls.set(name, (calls.get(name) || 0) + 1);
    if (name === 'fintraffic' && fail) return [];
    return [camera(`${name}-1`, name === 'vegvesen' ? oslo.lat : helsinki.lat, name === 'vegvesen' ? oslo.lon : helsinki.lon)];
  });
  const getSources = createCctvCatalog({ env: {}, now: () => clock });
  await getSources(helsinki); await getSources(oslo);
  fail = true; clock += CCTV_SOURCE_CACHE_MS + 1;
  const stale = await getSources.getCatalog(helsinki);
  assert.equal(stale.sources.length, 1); assert.equal(stale.stale, true); assert.equal(stale.providers[0].status, 'stale');
  assert.equal(stale.ageMs, CCTV_SOURCE_CACHE_MS + 1);
  await getSources(helsinki); assert.equal(calls.get('fintraffic'), 2); assert.equal(calls.get('vegvesen'), 1);
  fail = false; clock += CCTV_SOURCE_CACHE_MS + 1;
  assert.equal((await getSources.getCatalog(helsinki)).stale, false); assert.equal(calls.get('fintraffic'), 3);
});

test('a successful empty provider response removes old records rather than serving them stale', async (t) => {
  let clock = 0, empty = false;
  mockPacks(t, async () => prioritizeSources(empty ? [] : [camera('fi-a')], 8, [helsinki], { retainAll: true }));
  const getSources = createCctvCatalog({ env: {}, now: () => clock });
  assert.equal((await getSources(helsinki)).length, 1);
  empty = true; clock += CCTV_SOURCE_CACHE_MS + 1;
  const result = await getSources.getCatalog(helsinki);
  assert.deepEqual(result.sources, []); assert.equal(result.stale, false); assert.equal(result.coverage.status, 'empty');
  assert.equal(await getSources.getById('fi-a'), null);
});

test('revoked providers and DriveBC IDs cannot be resolved from warm full-pack caches', async (t) => {
  let calls = 0;
  mockPacks(t, async (name) => { calls++; return [camera(`${name}-13`, 49.2, -123.1), camera(`${name}-14`, 49.2, -123.1)]; });
  const env = { CCTV_DRIVEBC_TERMS_ACCEPTED: '1', CCTV_DRIVEBC_APPROVED_IDS: '13,14' };
  const getSources = createCctvCatalog({ env });
  assert.equal((await getSources.getById('drivebc-13')).id, 'drivebc-13');
  env.CCTV_DRIVEBC_APPROVED_IDS = '14'; assert.equal(await getSources.getById('drivebc-13'), null);
  assert.equal(getSources.isRegistered('drivebc-13'), false); assert.equal(getSources.isRegistered('drivebc-14'), true);
  env.CCTV_DRIVEBC_TERMS_ACCEPTED = '0'; assert.equal(await getSources.getById('drivebc-14'), null);
  assert.equal(getSources.isRegistered('drivebc-14'), false); assert.equal(calls, 1);
});

test('retained full catalogs are bounded and report sampled coverage when the bound is reached', async (t) => {
  const records = Array.from({ length: CCTV_MAX_SOURCES_CEILING + 1 }, (_, i) => camera(`fi-${i}`));
  mockPacks(t, async () => prioritizeSources(records, 8, [helsinki], { retainAll: true }));
  const result = await createCctvCatalog({ env: {} }).getCatalog(helsinki);
  assert.equal(result.sources.length, 8); assert.equal(result.providers[0].matched, CCTV_MAX_SOURCES_CEILING);
  assert.equal(result.providers[0].incomplete, true); assert.equal(result.coverage.incomplete, true);
});

test('malformed NSW and Vegvesen successes retain stale data; valid empty feature arrays retire it', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fixtures = [
    { name: 'nsw', area: { lat: -33.869, lon: 151.209, radiusKm: 10 }, feature: {
      id: 'fixture', geometry: { coordinates: [151.209, -33.869] },
      properties: { href: 'https://webcams.transport.nsw.gov.au/fixture.jpg' },
    } },
    { name: 'vegvesen', area: oslo, feature: {
      geometry: { coordinates: [oslo.lon, oslo.lat] },
      properties: { cameraId: 'fixture', stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/fixture' },
    } },
  ];
  for (const fixture of fixtures) {
    let clock = 1000, payload = { features: [fixture.feature] };
    const env = { CCTV_FINTRAFFIC_ENABLED: '0', CCTV_NSW_ENABLED: '0', CCTV_CALGARY_ENABLED: '0', CCTV_VEGVESEN_ENABLED: '0',
      [`CCTV_${fixture.name.toUpperCase()}_ENABLED`]: '1' };
    const getSources = createCctvCatalog({ env, now: () => clock, fetchImpl: async () => Response.json(payload) });
    const first = await getSources.getCatalog(fixture.area);
    assert.equal(first.sources.length, 1, fixture.name); const originalRetrieval = first.providers[0].retrievedAt;
    payload = { error: 'Maintenance' }; clock += CCTV_SOURCE_CACHE_MS + 1;
    const stale = await getSources.getCatalog(fixture.area);
    assert.equal(stale.sources.length, 1, fixture.name); assert.equal(stale.providers[0].status, 'stale');
    assert.equal(stale.providers[0].retrievedAt, originalRetrieval); assert.equal(stale.stale, true);
    payload = { features: [] }; clock += CCTV_SOURCE_CACHE_MS + 1;
    const empty = await getSources.getCatalog(fixture.area);
    assert.equal(empty.sources.length, 0, fixture.name); assert.equal(empty.providers[0].status, 'ready');
    assert.equal(empty.coverage.status, 'empty'); assert.equal(empty.stale, false);
    assert.equal(await getSources.getById(first.sources[0].id), null);
  }
});
