import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { appendHistorySnapshot, createHistoryHandler, readPreparedIntelligence } from './history.js';
import { COLLECTOR_PLUGINS, collectEarthSources, getCollectorStatus, persistEarthCollection } from './collector.js';
import { normalizeUsgs, normalizeGdacs, normalizeGdelt } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { gdeltQueryUrl } from '../server/hosted/gdelt-query.js';
import { GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';

const CLOCK = Date.parse('2026-10-11T15:00:00.000Z'), stamp = (at) => new Date(at).toISOString();
const request = (query = '', options) => new Request(`https://example.test/api/history${query}`, options);

function bucket() {
  const records = new Map(); let serial = 0;
  return { records,
    async get(key) {
      const value = records.get(key); if (!value) return null;
      return { etag: value.etag, size: new TextEncoder().encode(value.body).byteLength, json: async () => JSON.parse(value.body) };
    },
    async put(key, body, options = {}) {
      const previous = records.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
      const value = { body: typeof body === 'string' ? body : new TextDecoder().decode(body), etag: String(++serial) };
      records.set(key, value); return value;
    },
  };
}

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE earth_observations (source TEXT NOT NULL, at TEXT NOT NULL, snapshot_id TEXT NOT NULL, record_count INTEGER NOT NULL, PRIMARY KEY(source, at)); CREATE INDEX earth_observations_at ON earth_observations(at);');
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...values) { return {
      async all() { return { results: statement.all(...values) }; },
      async first() { return statement.get(...values) || null; },
      async run() { return statement.run(...values); },
    }; } };
  } };
}

function quake(at = CLOCK, revision = 0) {
  return { type: 'FeatureCollection', features: [{ id: 'qa-quake', geometry: { type: 'Point', coordinates: [4, 50, 12] },
    properties: { title: 'M 5.1 - source earthquake', place: 'source location', mag: 5.1, status: 'reviewed',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/qa-quake', time: at - 300000, updated: at - 60000 + revision } }] };
}

function gdacs(at = CLOCK) {
  return { features: [{ geometry: { type: 'Point', coordinates: [4.2, 50.2] }, properties: { eventid: 12, episodeid: 1, eventtype: 'FL',
    name: 'Source flood notice', url: { report: 'https://www.gdacs.org/report.aspx?eventid=12&eventtype=FL' },
    fromdate: stamp(at - 3600000), datemodified: stamp(at - 60000), alertlevel: 'Green', affectedcountries: [{ iso2: 'BE' }] } }] };
}

function gdelt(at = CLOCK) {
  const retrievedAt = stamp(at), categories = Object.fromEntries(['geopolitics', 'economy', 'disasters'].map((category) => [category, {
    queryUrl: gdeltQueryUrl({ category }), retrievedAt, reports: normalizeGdelt({ articles: [{
      title: `Source ${category} metadata`, url: `https://publisher.test/${category}`, seendate: stamp(at - 60000),
    }] }, retrievedAt, category),
  }]));
  return { schemaVersion: 1, generatedAt: retrievedAt, source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: ['geopolitics', 'economy', 'disasters'] }, categories };
}

function eonet(at = CLOCK) {
  return { events: [{ id: 'EONET_123', title: 'Source wildfire reference', categories: [{ id: 'wildfires' }],
    sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/incident/source' }], closed: null,
    geometry: [{ date: stamp(at - 7200000), type: 'Point', coordinates: [4.3, 50.3] }] }] };
}

test('durable history deduplicates immutable content while indexing actual checks and selecting source evidence available by a time', async (t) => {
  const storage = bucket(), env = { EARTH_STORE: storage, EARTH_DB: database(t) }, now = () => CLOCK + 180000;
  const records = normalizeUsgs(quake(), stamp(CLOCK)).map(canonicalDiscoveryRecord), coordinates = [{ id: records[0].id, lat: 50, lon: 4 }];
  const first = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK), records, coordinates }, { now });
  const repeated = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK + 60000), records, coordinates }, { now });
  assert.equal(repeated.id, first.id); assert.equal(repeated.existingSnapshot, true);
  const reacquired = records.map((record) => ({ ...record, retrievedAt: stamp(CLOCK + 90000) }));
  const unchanged = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK + 90000), records: reacquired, coordinates }, { now });
  assert.equal(unchanged.id, first.id); assert.equal(unchanged.existingSnapshot, true, 'new retrieval dates alone do not duplicate unchanged facts');
  const changed = normalizeUsgs(quake(CLOCK, 120000), stamp(CLOCK + 120000)).map(canonicalDiscoveryRecord);
  const revised = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK + 120000), records: changed, coordinates }, { now });
  assert.notEqual(revised.id, first.id);
  const flood = normalizeGdacs(gdacs(), stamp(CLOCK)).map(canonicalDiscoveryRecord);
  await appendHistorySnapshot(env, { source: 'gdacs', at: stamp(CLOCK), records: flood }, { now });
  assert.equal([...storage.records.keys()].filter((key) => key.startsWith('history/snapshots/usgs/')).length, 2);
  assert.equal([...storage.records.keys()].filter((key) => key.startsWith('history/observations/usgs/')).length, 4);
  const handle = createHistoryHandler({ env, now });
  const overview = await (await handle(request())).json();
  assert.equal(overview.indexMode, 'd1-full-history'); assert.equal(overview.sources.length, 2); assert.equal(overview.snapshots.length, 5);
  assert.equal(overview.firstAt, stamp(CLOCK)); assert.equal(overview.lastAt, stamp(CLOCK + 120000));
  const selected = await (await handle(request(`?at=${encodeURIComponent(stamp(CLOCK + 90000))}`))).json();
  assert.equal(selected.snapshots.length, 2); assert.equal(selected.snapshots.find((row) => row.source === 'usgs').id, first.id);
  assert.equal(selected.reports.find((row) => row.sourceId === 'usgs').updatedAt, records[0].updatedAt);
  assert.equal(selected.reports.find((row) => row.sourceId === 'usgs').retrievedAt, records[0].retrievedAt);
  assert.deepEqual(selected.coordinates, coordinates);
  assert.equal(selected.windowStartAt, stamp(CLOCK + 90000));
  assert.equal(selected.nextCaptureAt, stamp(CLOCK + 120000), 'playback advances only at the next retained evidence boundary');
  const range = await (await handle(request(`?from=${encodeURIComponent(stamp(CLOCK + 30000))}&to=${encodeURIComponent(stamp(CLOCK + 90000))}&limit=1`))).json();
  assert.equal(range.snapshots.length, 1); assert.equal(range.snapshots[0].at, stamp(CLOCK + 90000));
  const before = await (await handle(request(`?at=${encodeURIComponent(stamp(CLOCK - 1))}`))).json();
  assert.deepEqual(before.reports, []); assert.deepEqual(before.coordinates, []);
  assert.equal(before.windowStartAt, null); assert.equal(before.nextCaptureAt, stamp(CLOCK));
});

test('D1 range queries reach archived observations outside the bounded recent R2 manifest and R2 fallback discloses its limit', async (t) => {
  const storage = bucket(), db = database(t), env = { EARTH_STORE: storage, EARTH_DB: db }, oldest = CLOCK - 7 * 86400000;
  const records = normalizeUsgs(quake(oldest), stamp(oldest)).map(canonicalDiscoveryRecord);
  const first = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(oldest), records }, { now: () => CLOCK });
  const insert = db.sqlite.prepare('INSERT INTO earth_observations VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 1201; i++) insert.run('usgs', stamp(oldest + i * 60000), first.id, 1);
  await appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK), records: normalizeUsgs(quake(), stamp(CLOCK)).map(canonicalDiscoveryRecord) }, { now: () => CLOCK });
  const stored = storage.records.get('history/manifests/usgs.json'), value = JSON.parse(stored.body);
  value.snapshots = value.snapshots.slice(-1); stored.body = JSON.stringify(value);
  const target = stamp(oldest + 3600000);
  const selected = await (await createHistoryHandler({ env, now: () => CLOCK })(request(`?at=${encodeURIComponent(target)}`))).json();
  assert.equal(selected.indexMode, 'd1-full-history'); assert.equal(selected.reports[0].retrievedAt, stamp(oldest));
  assert.equal(selected.sources[0].observations, 1203);
  assert.equal(selected.nextCaptureAt, stamp(oldest + 3660000), 'an older archive date receives its next boundary beyond the recent manifest');
  const recent = await (await createHistoryHandler({ env: { EARTH_STORE: storage }, now: () => CLOCK })(request(`?at=${encodeURIComponent(target)}`))).json();
  assert.equal(recent.indexMode, 'r2-recent-history'); assert.deepEqual(recent.reports, []);
  assert.match(recent.indexWarning, /full historical range queries require/); assert.equal(recent.sources[0].availableFrom, stamp(CLOCK));
});

test('conditional R2 manifests preserve competing writer observations and selected content verifies its hash', async () => {
  const storage = bucket(), proxy = () => ({ get: storage.get.bind(storage), put: storage.put.bind(storage) });
  const records = normalizeUsgs(quake(), stamp(CLOCK)).map(canonicalDiscoveryRecord);
  const one = { EARTH_STORE: proxy() }, two = { EARTH_STORE: proxy() };
  await Promise.all([appendHistorySnapshot(one, { source: 'usgs', at: stamp(CLOCK), records }, { now: () => CLOCK + 60000 }),
    appendHistorySnapshot(two, { source: 'usgs', at: stamp(CLOCK + 60000), records }, { now: () => CLOCK + 60000 })]);
  const handle = createHistoryHandler({ env: one, now: () => CLOCK + 60000 });
  const overview = await (await handle(request())).json(); assert.equal(overview.snapshots.length, 2);
  const key = [...storage.records.keys()].find((key) => key.startsWith('history/snapshots/'));
  const body = JSON.parse(storage.records.get(key).body); body.records[0].title = 'Altered content'; storage.records.get(key).body = JSON.stringify(body);
  assert.equal((await handle(request(`?at=${encodeURIComponent(stamp(CLOCK + 60000))}`))).status, 503);
});

test('history is read-only, rejects malformed ranges and never invents historical EONET coordinates', async () => {
  const storage = bucket(), env = { EARTH_STORE: storage }, handle = createHistoryHandler({ env, now: () => CLOCK });
  assert.equal(await handle(new Request('https://example.test/other')), null);
  assert.equal((await handle(request('', { method: 'POST', body: '{}' }))).status, 405);
  for (const query of ['?at=2026-02-30T00:00:00Z', '?limit=1201', '?limit=2&limit=3', '?unknown=1', '?at=2027-01-01T00:00:00Z',
    '?from=2026-10-11T12:00:00Z&to=2026-10-10T12:00:00Z', '?at=2026-10-11T12:00:00Z&from=2026-10-11T11:00:00Z']) {
    assert.equal((await handle(request(query))).status, 400, query);
  }
  const unconfigured = await (await createHistoryHandler()(request())).json(); assert.equal(unconfigured.configured, false); assert.deepEqual(unconfigured.snapshots, []);
  const records = normalizeUsgs(quake(), stamp(CLOCK)).map(canonicalDiscoveryRecord);
  await assert.rejects(appendHistorySnapshot(env, { source: 'usgs', at: stamp(CLOCK), records,
    coordinates: [{ id: records[0].id, lat: 100, lon: 4 }] }, { now: () => CLOCK }), /coordinates/);
  await assert.rejects(appendHistorySnapshot(env, { source: 'gdacs', at: stamp(CLOCK), records: normalizeGdacs(gdacs(), stamp(CLOCK)).map(canonicalDiscoveryRecord),
    coordinates: [{ id: 'gdacs:FL:12:1', lat: 50, lon: 4 }] }, { now: () => CLOCK }), /USGS/);
});

test('fixed collector prepares and archives all registered sources independently of visitor toggles, while visitors read without acquisition', async (t) => {
  let clock = CLOCK, fail = false; const now = () => clock, urls = [], env = { EARTH_STORE: bucket(), EARTH_DB: database(t) };
  const fetchImpl = async (input) => {
    const url = String(input); urls.push(url);
    if (fail) return new Response('provider temporarily unavailable', { status: 503 });
    if (url === GDELT_SNAPSHOT_URL) return Response.json(gdelt());
    if (url === EONET_QUERY_URL) return Response.json(eonet());
    if (url === COLLECTOR_PLUGINS[0].endpoint) return Response.json(quake());
    if (url.startsWith(COLLECTOR_PLUGINS[1].endpoint)) return Response.json(gdacs());
    throw new Error('Unregistered acquisition');
  };
  const [first, concurrent] = await Promise.all([collectEarthSources(env, {}, { now, fetchImpl }), collectEarthSources(env, {}, { now, fetchImpl })]);
  assert.equal(concurrent, first); assert.equal(first.status, 'stored'); assert.equal(first.snapshots.length, 4); assert.equal(urls.length, 4);
  assert.ok(urls.every((url) => !url.includes('.zip') && !url.startsWith('https://publisher.test/')));
  const prepared = await readPreparedIntelligence(env, { now }); assert.equal(prepared.payload.sources.length, 4);
  assert.equal(prepared.payload.indexRecords.length, 6);
  const nasa = prepared.payload.indexRecords.find((record) => record.sourceId === 'eonet'); assert.equal(nasa.lat, undefined); assert.equal(nasa.lon, undefined);
  assert.equal(nasa.sourceGeometryAt, stamp(CLOCK - 7200000));
  const calls = urls.length;
  await createHistoryHandler({ env, now })(request(`?at=${encodeURIComponent(stamp(CLOCK))}`));
  await readPreparedIntelligence(env, { now }); assert.equal(urls.length, calls, 'history and current readers never call any source');
  clock += 1000;
  const checked = await collectEarthSources(env, {}, { now, fetchImpl }); assert.equal(urls.length, calls);
  assert.ok(checked.snapshots.every((snapshot) => snapshot.existingSnapshot));
  clock += 60000; fail = true;
  const outage = await collectEarthSources(env, {}, { now, fetchImpl });
  assert.equal(outage.packet, undefined, 'stored collector results return a small summary, not all metadata');
  const retained = await readPreparedIntelligence(env, { now });
  assert.equal(retained.payload.indexRecords.length, 6); assert.ok(retained.payload.sources.every((source) => source.status === 'stale'));
  assert.ok(retained.payload.indexRecords.every((record) => record.retrievedAt === stamp(CLOCK)));
  const failures = urls.length; clock += 1000; await collectEarthSources(env, {}, { now, fetchImpl }); assert.equal(urls.length, failures, 'provider backoff survives repeated collector requests');
  const status = await getCollectorStatus(env, { now }); assert.equal(status.unattendedVerified, false); assert.equal(status.plugins.length, 4);
  assert.equal(status.declaredTrigger, null); assert.equal(status.configured, true);
  clock += 86400001; assert.equal(await readPreparedIntelligence(env, { now }), null, 'expired current publication is never presented as current');
});

test('portable collection packets can be persisted by an authenticated host without retiming their source or collector capture', async (t) => {
  const input = { schemaVersion: 1, collectedAt: stamp(CLOCK), payload: { indexRecords: normalizeUsgs(quake(), stamp(CLOCK)).map(canonicalDiscoveryRecord),
    sources: [{ id: 'usgs', name: 'USGS', status: 'ready', retrievedAt: stamp(CLOCK) }], retrievedAt: stamp(CLOCK), reports: [], nextRefreshMs: 60000 } };
  const env = { EARTH_STORE: bucket(), EARTH_DB: database(t) };
  await persistEarthCollection(env, input, { now: () => CLOCK + 60000 });
  const restored = await readPreparedIntelligence(env, { now: () => CLOCK + 60000 }); assert.equal(restored.collectedAt, stamp(CLOCK)); assert.equal(restored.ageMs, 60000);
  assert.equal(restored.payload.indexRecords[0].retrievedAt, stamp(CLOCK));
  const changed = structuredClone(input); changed.collectedAt = stamp(CLOCK - 60000);
  await persistEarthCollection(env, changed, { now: () => CLOCK + 60000 });
  assert.equal((await readPreparedIntelligence(env, { now: () => CLOCK + 60000 })).collectedAt, stamp(CLOCK), 'old packets cannot overwrite a later current publication');
  const arbitrary = structuredClone(input); arbitrary.payload.sources[0].id = 'arbitrary-web-crawler';
  await assert.rejects(persistEarthCollection(env, arbitrary, { now: () => CLOCK }), /Unregistered/);
});

test('collector and history package bundle for a Worker without bulk decoding or Node runtime imports', async () => {
  const result = await build({ entryPoints: ['worker/collector.js', 'worker/history.js'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    write: false, metafile: true, outdir: 'not-written', logLevel: 'silent' });
  assert.equal(result.errors.length, 0);
  assert.equal(Object.keys(result.metafile.inputs).some((path) => /scripts\/gdelt-snapshot|wind\/decode|eccodes/.test(path)), false);
  for (const output of Object.values(result.metafile.outputs)) assert.equal(output.imports.some((item) => item.path.startsWith('node:')), false);
});
