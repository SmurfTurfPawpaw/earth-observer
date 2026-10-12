import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createEarthRuntime } from './index.js';
import { createProviderStore } from './storage.js';
import { createSpaceHandler } from './space.js';
import { createWindArtifactHandler } from './wind.js';
import { createContextHandler } from './context.js';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { documentFixture, syntheticPdf, syntheticAnalysis } from './document-investigation-fixture.mjs';
import { documentProducerMessage } from './document-investigation-api.js';
import { retainDocumentRaw, completeDocumentInvestigation } from './document-investigations.js';
import { runSourcePlugin } from './plugins/store.js';
import { USGS_LIVE_DAY_PLUGIN,collectUsgsLiveDay,usgsLiveDayItems } from './plugins/usgs-live-day.js';

const request = (path, options) => new Request(`https://example.com${path}`, options);
test('mounted scientific observation route serves only retained source data before generic cache/providers without advancing other history',async t=>{
  const f=await documentFixture(t),plugin={...USGS_LIVE_DAY_PLUGIN,collect:collectUsgsLiveDay,items:usgsLiveDayItems};
  const result=await runSourcePlugin(f.env,plugin,{now:f.now,fetchImpl:async()=>Response.json({type:'FeatureCollection',metadata:{generated:f.now(),count:1,status:200,url:plugin.sourceUrl},
    features:[{type:'Feature',id:'testruntime',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:3,time:f.now()-1000,updated:f.now(),type:'earthquake',
      status:'reviewed',url:'https://earthquake.usgs.gov/earthquakes/eventpage/testruntime'}}]})});assert.equal(result.status,'stored');
  let upstream=0,cached=0;const runtime=createEarthRuntime({now:f.now,providers:[],fetchImpl:async()=>{upstream++;throw Error('No visitor acquisition');},
    cache:{match:async()=>{cached++;throw Error('No generic observation cache');},put:async()=>{cached++;}}});
  f.reset();const response=await runtime.fetch(request('/earth/api/layers/earthquakes'),f.env,{}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.records[0].mag,3);assert.equal(data.scope.id,plugin.scopeId);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(upstream,0);assert.equal(cached,0);
  assert.equal(f.activity.sql.filter(row=>row.write).length,0);assert.equal(f.activity.objects.filter(row=>row.operation==='put').length,0);
  assert.equal((await runtime.fetch(request('/earth/api/layers/earthquakes?url=https://evil.test'),f.env,{})).status,400);
  assert.equal((await runtime.fetch(request('/earth/api/layers/earthquakes',{method:'POST'}),f.env,{})).status,405);
  assert.equal((await runtime.fetch(request('/earth/api/layers/earthquakes'),{},{})).status,503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_plugin_captures').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_plugin_state').get().n,1,'no existing four-source or archive publication was created');
});
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

test('actual generated document migration adds only four tables and mounted paths bypass acquisition/cache while preserving background context', async t => {
  const f = await documentFixture(t, { documents: false });
  const before = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  const sql = await readFile(new URL('../drizzle/0010_document_investigations.sql', import.meta.url), 'utf8');
  assert.equal(/\b(?:ALTER|DROP|DELETE|UPDATE|INSERT)\b/i.test(sql), false, 'migration must not modify prior stores or history');
  assert.equal((sql.match(/CREATE TABLE /g) || []).length, 4);
  assert.equal((sql.match(/CREATE (?:UNIQUE )?INDEX /g) || []).length, 7);
  f.sqlite.exec(sql);
  const after = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(after.filter(name => !before.includes(name)), ['earth_document_attempts', 'earth_document_publications', 'earth_document_raw_receipts', 'earth_document_work']);
  await f.source(); f.reset();
  let fetches = 0, cacheCalls = 0;
  const runtime = createEarthRuntime({ now: f.now, fetchImpl: async () => { fetches++; assert.fail('Document routing cannot acquire a provider'); },
    cache: { match: async () => { cacheCalls++; assert.fail('Document routing cannot enter provider cache'); }, put: async () => { cacheCalls++; assert.fail('Document routing cannot write provider cache'); } } });
  t.after(() => runtime.close());
  const publicPath = '/earth/api/documents/ec-statement-26-2127', producerPath = '/earth/api/document-investigations/producer';
  const publicRead = await runtime.fetch(request(publicPath), f.env);
  assert.equal(publicRead.status, 200); assert.equal((await publicRead.json()).available, false);
  assert.equal(f.activity.sql.filter(row => row.write).length, 0); assert.equal(f.activity.objects.length, 0);
  const deniedTasks = [], privateRead = await runtime.fetch(request(producerPath, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), f.env,
    { waitUntil: task => deniedTasks.push(task) });
  assert.equal(privateRead.status, 503); assert.equal((await privateRead.json()).configured, false); assert.equal(deniedTasks.length, 0);
  const key = 'TEST-only-document-key-'.padEnd(64, 'x'), body = JSON.stringify({ schemaVersion: 1, operation: 'claim', workerId: 'runtime-test', claimId: 'a'.repeat(32) });
  const timestamp = String(Math.floor(f.now() / 1000)), nonce = 'b'.repeat(32), digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', key).update(documentProducerMessage(timestamp, nonce, digest)).digest('hex');
  const tasks = [], claim = await runtime.fetch(request(producerPath, { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-earth-document-timestamp': timestamp, 'x-earth-document-nonce': nonce, 'x-earth-document-digest': digest, 'x-earth-document-signature': signature } }),
    { ...f.env, EARTH_DOCUMENT_PRODUCER_KEY: key }, { waitUntil: task => tasks.push(task) });
  assert.equal(claim.status, 200); const job = (await claim.json()).job; assert.ok(job.leaseToken); assert.equal(tasks.length, 1); await Promise.all(tasks);
  const lease = { jobId: job.jobId, fence: job.fence, leaseToken: job.leaseToken }, bytes = syntheticPdf('runtime');
  f.advance(1000); const raw = await retainDocumentRaw(f.env, { ...lease, acquiredAt: f.stamp(), rawBytes: bytes }, { now: f.now });
  const rawAt = raw.receipt.recordedAt;
  assert.equal((await (await runtime.fetch(request(publicPath), f.env)).json()).available, false, 'raw-only receipt cannot become a complete public analysis');
  f.advance(1000); const complete = await completeDocumentInvestigation(f.env, { ...lease, rawReceiptId: raw.receipt.id, ...await syntheticAnalysis(bytes) }, { now: f.now });
  assert.equal(complete.stored, true);
  const current = await (await runtime.fetch(request(publicPath), f.env)).json(); assert.equal(current.receipt.id, complete.receipt.id);
  const original = await runtime.fetch(request(publicPath + '/original?receipt=' + encodeURIComponent(raw.receipt.id)), f.env);
  assert.equal(original.status, 200);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), bytes);
  const policies = original.headers.get('content-security-policy').split(',').map(policy => policy.trim());
  assert.equal(policies.length, 2, 'the stricter leaf policy and global application policy must both survive mounting');
  assert.ok(policies.some(policy => policy.includes("default-src 'none'") && /(?:^|;)\s*sandbox\s*(?:;|$)/.test(policy)));
  assert.ok(policies.some(policy => policy.includes("default-src 'self'") && policy.includes("object-src 'none'")));
  assert.match(original.headers.get('content-disposition'), /^attachment;/);
  assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
  const historical = await (await runtime.fetch(request(publicPath + '?knownAt=' + encodeURIComponent(rawAt)), f.env)).json(); assert.equal(historical.available, false);
  assert.equal(fetches, 0); assert.equal(cacheCalls, 0); assert.equal(f.activity.providers.length, 0);
});

test('archive and scene paths precede generic world routing and cannot enter provider acquisition', async () => {
  let fetched = 0;
  const runtime = createEarthRuntime({ fetchImpl: async () => { fetched++; throw new Error('Unexpected provider acquisition'); } });
  const scene = await runtime.fetch(request('/earth/api/world/scene?at=2025-10-08T00:00:00.000Z'));
  assert.equal(scene.status, 503); assert.equal((await scene.json()).configured, false);
  const archive = await runtime.fetch(request('/earth/api/world/archive/import', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
  assert.equal(archive.status, 503);
  const receipt = await runtime.fetch(request('/earth/api/world/archive/chunks/' + 'a'.repeat(64)));
  assert.equal(receipt.status, 503); assert.equal((await receipt.json()).configured, false);
  const badScene = await runtime.fetch(request('/earth/api/world/scene?at=2025-10-08T00:00:00.000Z&provider=https://unreviewed.example'));
  assert.equal(badScene.status, 400); assert.equal(fetched, 0); runtime.close();
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
