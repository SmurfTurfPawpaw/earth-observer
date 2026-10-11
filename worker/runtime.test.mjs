import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createEarthRuntime } from './index.js';
import { createProviderStore } from './storage.js';
import { createSpaceHandler } from './space.js';
import { createWindArtifactHandler } from './wind.js';
import { createContextHandler } from './context.js';

const request = (path, options) => new Request(`https://example.com${path}`, options);
function bucket() {
  const records = new Map(); let serial = 0;
  return {
    records,
    async get(key) {
      const record = records.get(key);
      if (!record) return null;
      return { etag: record.etag, customMetadata: record.customMetadata, body: new Response(record.bytes).body,
        json: () => new Response(record.bytes).json() };
    },
    async put(key, value, options = {}) {
      const existing = records.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && existing || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== existing?.etag) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice();
      const record = { bytes, etag: String(++serial), customMetadata: options.customMetadata };
      records.set(key, record); return record;
    },
  };
}

test('Worker browser bundle has no Node runtime imports or ecCodes decoder', async () => {
  const result = await build({ entryPoints: ['worker/index.js'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, metafile: true, logLevel: 'silent' });
  assert.equal(result.errors.length, 0);
  assert.equal(Object.keys(result.metafile.inputs).some((name) => name.includes('eccodes') || name.includes('wind/decode')), false);
  assert.equal(result.metafile.outputs['index.js'].imports.some((item) => item.path.startsWith('node:')), false);
});

test('runtime leaves portfolio routes alone and serves /earth assets without constructing providers', async () => {
  let fetched = 0;
  const runtime = createEarthRuntime({ fetchImpl: async () => { fetched++; throw new Error('Unexpected fetch'); } });
  assert.equal(await runtime.fetch(request('/journal/')), null);
  assert.equal((await runtime.fetch(request('/earth'))).status, 308);
  const asset = await runtime.fetch(request('/earth/'), {}, {}, async (value) => new Response(new URL(value.url).pathname, { headers: { 'content-type': 'text/html' } }));
  assert.equal(await asset.text(), '/earth/'); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await runtime.fetch(request('/earth/healthz'))).status, 200); assert.equal(fetched, 0); runtime.close();
});

test('Worker adapters preserve shared aircraft records and NASA archive without unrelated upstream fetches', async () => {
  const urls = [];
  const runtime = createEarthRuntime({ fetchImpl: async (url) => { urls.push(String(url)); return new Response('{"ac":[{"hex":"123abc","lat":4,"lon":5}]}', { headers: { 'content-type': 'application/json' } }); } });
  const first = await runtime.fetch(request('/earth/api/flights?lat=4&lon=5'));
  assert.equal((await first.json()).ac[0].hex, '123abc');
  assert.equal((await runtime.fetch(request('/earth/api/flights?lat=4&lon=5'))).headers.get('x-feed-cache'), 'HIT');
  const archive = await (await runtime.fetch(request('/earth/api/firms'))).json();
  assert.equal(archive.snapshot, true); assert.equal(archive.count, 45); assert.equal(archive.observationDate, '2026-07-16');
  assert.equal(urls.length, 1); assert.match(urls[0], /^https:\/\/api\.adsb\.lol\//); runtime.close();
});

test('Worker economics preserves annual provenance and aliases share one fixed-source request', async () => {
  const clock = Date.parse('2026-10-11T00:00:00Z'), urls = [];
  const fixture = [{ page: 1, pages: 1, total: 1, sourceid: '2', lastupdated: '2026-10-07' },
    [{ indicator: { id: 'NY.GDP.MKTP.CD' }, country: { id: 'BE', value: 'Belgium' }, countryiso3code: 'BEL', date: '2025', value: 123, footnote: '' }]];
  const runtime = createEarthRuntime({ now: () => clock, fetchImpl: async (url) => {
    urls.push(String(url)); return new Response(JSON.stringify(fixture));
  } });
  const facts = await (await runtime.fetch(request('/earth/api/economics?country=BE'))).json();
  assert.equal(facts.status, 'ready'); assert.equal(facts.frequency, 'annual');
  assert.equal(facts.country.id, 'BEL'); assert.equal(facts.indicators[0].year, 2025);
  assert.equal(facts.source.license, 'CC BY 4.0'); assert.equal(facts.retrievedAt, new Date(clock).toISOString());
  assert.equal((await runtime.fetch(request('/earth/api/economics?country=BEL'))).status, 200);
  assert.equal((await runtime.fetch(request('/earth/api/economics?country=ZZ'))).status, 400);
  assert.equal(urls.length, 1); const url = new URL(urls[0]);
  assert.equal(url.origin, 'https://api.worldbank.org'); assert.match(url.pathname, /^\/v2\/country\/BEL\/indicator\//);
  assert.equal(url.searchParams.get('source'), '2'); runtime.close();
});

test('authenticated extensions receive normalized paths before generic method restrictions', async () => {
  const runtime = createEarthRuntime({ providers: [], handlers: [async (value) => {
    assert.equal(new URL(value.url).pathname, '/api/evidence/submissions');
    assert.equal(value.headers.get('oai-authenticated-user-id'), 'trusted');
    return new Response(await value.text(), { status: 202 });
  }] });
  const value = await runtime.fetch(request('/earth/api/evidence/submissions', { method: 'POST', body: 'note', headers: { 'oai-authenticated-user-id': 'trusted' } }));
  assert.equal(value.status, 202); assert.equal(await value.text(), 'note'); runtime.close();
});

test('R2 attempt reservations coalesce across isolates and refresh after their explicit expiry', async () => {
  const storage = bucket(), one = createProviderStore({ EARTH_STORE: storage }), two = createProviderStore({ EARTH_STORE: storage });
  const claims = await Promise.all([one.claim('group', 1000, 10000), two.claim('group', 1000, 10000)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await two.claim('group', 2000, 10000), false);
  assert.equal(await two.claim('group', 11000, 10000), true);
  await one.put('data', { value: 42 }); assert.deepEqual(await two.get('data'), { value: 42 });
});

test('satellite non-200 pauses all later provider requests across cold runtimes', async () => {
  const store = createProviderStore({ EARTH_STORE: bucket() }); let calls = 0;
  const options = { store, fetchImpl: async () => { calls++; return new Response('denied', { status: 403 }); }, now: () => 1000 };
  assert.equal((await createSpaceHandler(options)(request('/api/celestrak/stations'))).status, 503);
  assert.equal((await createSpaceHandler(options)(request('/api/celestrak/visual'))).status, 503);
  assert.equal(calls, 1);
});

async function windFixture(clock) {
  const body = new Float32Array([1, 2, 3, 4]);
  const gridSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const manifest = { schemaVersion: 1, model: 'gfs', cycle: { runIso: new Date(clock - 3600000).toISOString(), validIso: new Date(clock).toISOString() },
    fetchedAt: clock, publishedAt: new Date(clock).toISOString(), gridSha256,
    grid: { nx: 2, ny: 1, lo1: -180, la1: 90, dx: 180, dy: 180 }, gridUrl: '/api/wind/grid/gfs-test.bin?model=gfs', level: '10 m above ground', units: 'm/s' };
  return { body: new Uint8Array(body.buffer), manifest };
}

test('wind serves validated fixed release assets and grids work from a different Worker isolate', async () => {
  const clock = 1800000000000, fixture = await windFixture(clock), storage = bucket(), urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return String(url).endsWith('.manifest.json') ? new Response(JSON.stringify(fixture.manifest)) : new Response(fixture.body); };
  const options = { fetchImpl, now: () => clock, env: { EARTH_STORE: storage } };
  const one = createWindArtifactHandler(options);
  const manifest = await (await one(request('/api/wind/manifest?model=gfs'))).json();
  assert.equal(manifest.unavailable, undefined); assert.equal(manifest.dataMode, 'Scheduled forecast snapshot');
  const two = createWindArtifactHandler({ ...options, fetchImpl: async () => { throw new Error('Must use saved grid'); } });
  const grid = await two(request(manifest.gridUrl));
  assert.equal(grid.status, 200); assert.equal((await grid.arrayBuffer()).byteLength, 16);
  assert.equal(urls.length, 2); assert.ok(urls.every((url) => url.startsWith('https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/wind-data/')));
});

test('wind checksum mismatches retain a labeled last-good snapshot and cold outages restore R2 safely', async () => {
  let clock = 1800000000000, corrupt = false;
  const fixture = await windFixture(clock), storage = bucket();
  const options = { env: { EARTH_STORE: storage }, now: () => clock, fetchImpl: async (url) =>
    String(url).endsWith('.manifest.json') ? new Response(JSON.stringify(fixture.manifest)) : new Response(corrupt ? new Uint8Array(16) : fixture.body) };
  const handler = createWindArtifactHandler(options);
  await handler(request('/api/wind/manifest?model=gfs')); clock += 960000; corrupt = true;
  const stale = await (await handler(request('/api/wind/manifest?model=gfs'))).json();
  assert.equal(stale.stale, true); assert.equal(stale.gridSha256, fixture.manifest.gridSha256);
  const restored = createWindArtifactHandler({ ...options, fetchImpl: async () => { throw new Error('Offline'); } });
  const cold = await (await restored(request('/api/wind/manifest?model=gfs'))).json();
  assert.equal(cold.stale, true); assert.match(cold.reason, /release update unavailable/);
  clock += 73 * 3600000;
  assert.equal((await (await restored(request('/api/wind/manifest?model=gfs'))).json()).unavailable, true);
});

test('Worker edge-cache errors cannot turn a successful source into a feed failure', async () => {
  const runtime = createEarthRuntime({ providers: [{ configureServer({ middlewares }) { middlewares.use('/api/test', (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' }); res.end('{"ok":true}'); }); } }],
    cache: { match: async () => { throw new Error('Unavailable'); }, put() { throw new Error('Full'); } } });
  const response = await runtime.fetch(request('/earth/api/test'));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); runtime.close();
});

test('a stored-update revalidation bypasses an older edge response', async () => {
  let reads = 0, writes = 0;
  const runtime = createEarthRuntime({ providers: [{ configureServer({ middlewares }) {
    middlewares.use('/api/test', (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' }); res.end('{"revision":"current"}'); });
  } }], cache: { match: async () => { ++reads; return Response.json({ revision: 'old' }); }, put: async () => { ++writes; } } });
  assert.equal((await (await runtime.fetch(request('/earth/api/test'))).json()).revision, 'old');
  assert.equal((await (await runtime.fetch(request('/earth/api/test', { headers: { 'Cache-Control': 'no-cache' } }))).json()).revision, 'current');
  assert.equal(reads, 1); assert.equal(writes, 0); runtime.close();
});

const mappedRequest = (lat) => request('/api/overpass', { method: 'POST', body:
  new URLSearchParams({ data: `[out:json];node["amenity"="bicycle_parking"](around:100,${lat},5);out body;` }).toString() });

test('Worker mapped context coalesces requests and evicts by bytes before its entry limit', async () => {
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const payload = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 4, lon: 5, tags: { name: 'A'.repeat(160) } }] });
  const handler = createContextHandler({ env: { OVERPASS_UPSTREAMS: 'https://owned-context.example/api/interpreter' },
    maxCacheBytes: new TextEncoder().encode(payload).byteLength + 10,
    fetchImpl: async () => { calls++; await gate; return new Response(payload); } });
  const first = handler(mappedRequest(4)), shared = handler(mappedRequest(4));
  release();
  assert.equal((await first).status, 200); assert.equal((await shared).status, 200);
  assert.equal(calls, 1, 'concurrent identical queries share one upstream read');
  assert.equal((await handler(mappedRequest(4))).headers.get('x-overpass-cache'), 'HIT');
  await handler(mappedRequest(5));
  assert.equal((await handler(mappedRequest(4))).headers.get('x-overpass-cache'), 'MISS');
  assert.equal(calls, 3, 'the byte budget evicts an old entry even with fewer than 40 entries');
});

test('Worker mapped context rejects unconfigured and oversized upstream data without caching it', async () => {
  let calls = 0, cancelled = false;
  const unconfigured = createContextHandler({ env: {}, fetchImpl: async () => { calls++; throw new Error('Unexpected network'); } });
  assert.equal((await unconfigured(mappedRequest(4))).status, 503); assert.equal(calls, 0);
  const handler = createContextHandler({ env: { OVERPASS_UPSTREAMS: 'https://owned-size.example/api/interpreter' }, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
  } });
  const failed = await handler(mappedRequest(4));
  assert.equal(failed.status, 502); assert.equal(cancelled, true);
  assert.equal((await handler(mappedRequest(4))).status, 502);
  assert.equal(calls, 1, 'a failed oversized request is cooled down rather than retained as valid data');
});
