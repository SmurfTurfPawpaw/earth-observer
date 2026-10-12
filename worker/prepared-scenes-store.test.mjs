import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentFixture, CLOCK } from './document-investigation-fixture.mjs';
import { runSourcePlugin } from './plugins/store.js';
import { USGS_LIVE_DAY_PLUGIN, collectUsgsLiveDay, usgsLiveDayItems } from './plugins/usgs-live-day.js';
import { ensurePreparedScene, readPreparedScene, PREPARED_SCENES_KEYS } from './prepared-scenes-store.js';
import { pluginJson } from '../src/core/plugin-evidence.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createWorldSourceItem } from '../src/core/world-model.js';
import { worldHash } from '../src/core/world-identity.js';
const UTF8 = new TextEncoder(), descriptor = { ...USGS_LIVE_DAY_PLUGIN, collect: collectUsgsLiveDay, items: usgsLiveDayItems };
const wait = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function raw(mag, at) { return JSON.stringify({ type: 'FeatureCollection', metadata: { generated: at, count: 1, status: 200, url: descriptor.sourceUrl },
  features: [{ type: 'Feature', id: 'us-generic-test', geometry: { type: 'Point', coordinates: [4, 50, 12] },
    properties: { mag, time: CLOCK - 600000, updated: CLOCK, status: 'reviewed', type: 'earthquake', place: 'TEST ONLY' } }] }); }
async function fixture(t) {
  const f = await documentFixture(t, { documents: false }); let sequence = 0, hook = null;
  f.sqlite.exec(await readFile(new URL('../drizzle/0000_glossy_overlord.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(await readFile(new URL('../drizzle/0003_world_evidence.sql', import.meta.url), 'utf8'));
  const versions = new Map();
  f.env.EARTH_STORE = {
    async get(key) { f.activity.objects.push({ operation: 'get', key }); await hook?.({ operation: 'get', key }); const body = f.objects.get(key);
      return body ? { etag: versions.get(key), size: body.length, arrayBuffer: async () => new Uint8Array(body).buffer } : null; },
    async put(key, value, options = {}) { f.activity.objects.push({ operation: 'put', key, options }); await hook?.({ operation: 'put', key, value, options });
      if (options.onlyIf?.get?.('if-none-match') === '*' && f.objects.has(key) || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== versions.get(key)) return null;
      const body = typeof value === 'string' ? UTF8.encode(value) : new Uint8Array(value); f.objects.set(key, body);
      const etag = `generic-${++sequence}`; versions.set(key, etag); return { etag }; },
  };
  return { ...f, versions, hook: value => { hook = value; },
    acquire: mag => runSourcePlugin(f.env, descriptor, { now: f.now, fetchImpl: async () => { f.activity.providers.push('fixture');
      return new Response(raw(mag, f.now()), { headers: { 'content-type': 'application/json' } }); } }) };
}
test('actual primary source receipts prepare once and unchanged minutes do not rewrite factual derivative slots', async t => {
  const f = await fixture(t); await f.acquire(6); assert.equal((await ensurePreparedScene(f.env, 'earthquakes', { now: f.now })).status, 'prepared');
  const first = await readPreparedScene(f.env, 'earthquakes', { now: f.now }); assert.equal(first.available, true); assert.equal(first.prepared.content.features[0].record.mag, 6);
  assert.equal(first.source.recordedAt, new Date(CLOCK).toISOString()); f.advance(60000); f.reset();
  const unchanged = await ensurePreparedScene(f.env, 'earthquakes', { now: f.now, readInput: () => assert.fail('unchanged source input rebuilt') });
  assert.equal(unchanged.status, 'ready'); assert.equal(f.activity.objects.some(row => row.operation === 'put'), false);
  f.reset(); const read = await readPreparedScene(f.env, 'earthquakes', { now: f.now }); assert.equal(read.prepared, first.prepared);
  assert.equal(f.activity.sql.some(row => row.write), false); assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
  const plans = f.activity.sql.flatMap(row => f.sqlite.prepare('EXPLAIN QUERY PLAN ' + row.sql).all(...row.values));
  assert.equal(plans.some(row => /SCAN c/.test(row.detail)), false);
});
test('A/B/A current and prior source editions remain exact, and public pending never builds or acquires', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); const a = await readPreparedScene(f.env, 'earthquakes', { now: f.now });
  f.advance(60001); await f.acquire(4); f.reset();
  const pending = await readPreparedScene(f.env, 'earthquakes', { now: f.now }); assert.equal(pending.available, false); assert.equal(pending.pending, true);
  assert.equal(f.activity.objects.some(row => row.operation === 'put'), false); assert.equal(f.activity.providers.length, 0);
  await ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); const b = await readPreparedScene(f.env, 'earthquakes', { now: f.now, includePrior: true });
  assert.equal(b.prior.source.receiptId, a.source.receiptId); f.advance(60001); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now });
  const again = await readPreparedScene(f.env, 'earthquakes', { now: f.now, includePrior: true }); assert.equal(again.prepared.contentDigest, a.prepared.contentDigest);
  assert.notEqual(again.source.receiptId, a.source.receiptId); assert.equal(again.prior.source.receiptId, b.source.receiptId);
  assert.deepEqual([...f.objects.keys()].filter(key => key.includes('retained-geographic-scenes-v1')).sort(), Object.values(PREPARED_SCENES_KEYS.earthquakes).sort());
});
test('late conditional current writer cannot overwrite a newer complete head across isolates', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); f.advance(60001); await f.acquire(4);
  const began = wait(), release = wait(); let paused = true;
  f.hook(async ({ operation, key }) => { if (operation === 'put' && key === PREPARED_SCENES_KEYS.earthquakes.current && paused) { paused = false; began.resolve(); await release.promise; } });
  const old = ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); await began.promise;
  f.advance(60001); await f.acquire(5); const other = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } };
  assert.equal((await ensurePreparedScene(other, 'earthquakes', { now: f.now })).status, 'prepared'); release.resolve();
  assert.equal((await old).status, 'superseded'); const latest = await readPreparedScene(f.env, 'earthquakes', { now: f.now });
  assert.equal(latest.available, true); assert.equal(latest.prepared.content.features[0].record.mag, 5);
  assert.equal(JSON.parse(new TextDecoder().decode(f.objects.get(PREPARED_SCENES_KEYS.earthquakes.current))).source.receiptId, latest.source.receiptId);
});
test('corrupt slots fail public admission and are repaired only by owner using the exact retained ETag', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now });
  f.objects.set(PREPARED_SCENES_KEYS.earthquakes.current, UTF8.encode('{bad')); f.versions.set(PREPARED_SCENES_KEYS.earthquakes.current, 'corrupt-retained-etag');
  const coldEnv = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } }; f.reset();
  assert.equal((await readPreparedScene(coldEnv, 'earthquakes', { now: f.now })).available, false); assert.equal(f.activity.objects.some(row => row.operation === 'put'), false);
  assert.equal((await ensurePreparedScene(coldEnv, 'earthquakes', { now: f.now })).status, 'prepared');
  const write = f.activity.objects.find(row => row.operation === 'put' && row.key === PREPARED_SCENES_KEYS.earthquakes.current);
  assert.equal(write.options.onlyIf.etagMatches, 'corrupt-retained-etag');
  f.objects.delete(PREPARED_SCENES_KEYS.earthquakes.current); f.versions.delete(PREPARED_SCENES_KEYS.earthquakes.current);
  const isolated = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } };
  assert.equal((await ensurePreparedScene(isolated, 'earthquakes', { now: f.now })).status, 'prepared');
  assert.equal((await readPreparedScene(isolated, 'earthquakes', { now: f.now })).available, true);
});
test('head change during public delivery returns the newer head pending; pre-aborted reads dispatch zero storage', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); let changed = false;
  const oldEnv = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } };
  f.hook(async ({ operation, key }) => { if (operation === 'get' && key === PREPARED_SCENES_KEYS.earthquakes.current && !changed) {
    changed = true; f.advance(60001); await f.acquire(4); } });
  const read = await readPreparedScene(oldEnv, 'earthquakes', { now: f.now }); assert.equal(read.available, false); assert.equal(read.pending, true);
  f.hook(null); const controller = new AbortController(); controller.abort(); f.reset();
  const cancelled = await readPreparedScene(f.env, 'earthquakes', { now: f.now, signal: controller.signal }); assert.equal(cancelled.available, false);
  assert.equal(f.activity.sql.length, 0); assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
  assert.equal((await readPreparedScene(f.env, 'gdacs', { now: f.now })).available, false);
  await assert.rejects(readPreparedScene(f.env, '__proto__', { now: f.now }));
});

test('native GDACS authority retains actual cohort and item clocks with no synthetic fence; unmapped evidence stays accessible', async t => {
  const f = await fixture(t), capturedAt = new Date(CLOCK - 1000).toISOString(), publishedAt = f.stamp();
  const records = [0, 1].map(i => canonicalDiscoveryRecord({ id: `gdacs:FL:${2000 + i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report',
    category: 'disasters', title: 'TEST ONLY', eventType: 'FL', ...(i ? {} : { lon: 4, lat: 50, alertLevel: 'Red' }),
    url: `https://www.gdacs.org/report.aspx?eventid=${2000 + i}&episodeid=1&eventtype=FL`, observedAt: capturedAt, updatedAt: capturedAt, retrievedAt: capturedAt }));
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt, ...record }) => record) });
  const items = await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt, recordedAt: publishedAt }),
    origin: { snapshotId, firstCapturedAt: capturedAt, firstRecordedAt: publishedAt, validation: 'retained-revision-index-only', bodyValidated: false } })));
  f.sqlite.prepare('INSERT INTO earth_world_captures(source_id,captured_at,snapshot_id,recorded_at) VALUES(?,?,?,?)').run('gdacs', capturedAt, snapshotId, publishedAt);
  f.sqlite.prepare('INSERT INTO earth_world_sources(source_id,captured_at,snapshot_id,recorded_at) VALUES(?,?,?,?)').run('gdacs', capturedAt, snapshotId, publishedAt);
  f.sqlite.prepare('INSERT INTO earth_observations(source,at,snapshot_id,record_count) VALUES(?,?,?,?)').run('gdacs', capturedAt, snapshotId, 2);
  const input = { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt, publishedAt }), readAt: publishedAt,
    cohort: { sourceId: 'gdacs', snapshotId, capturedAt, publishedAt, bodySha256: await worldHash(body), recordCount: 2 }, items,
    counts: { returned: 2, mapped: 1, unmapped: 1 }, coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
      completeRetainedCohort: true, completeProviderArchive: false }, operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
  assert.equal((await ensurePreparedScene(f.env, 'gdacs', { now: f.now, readInput: async () => input })).status, 'prepared');
  const cold = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } }, read = await readPreparedScene(cold, 'gdacs', { now: f.now });
  assert.equal(read.available, true); assert.equal(read.source.capturedAt, capturedAt); assert.equal(read.source.publishedAt, publishedAt);
  assert.equal(Object.hasOwn(read.source, 'fence'), false); assert.equal(read.check, null); assert.equal(read.sourceGenerationAgeMs, null);
  assert.equal(read.prepared.content.features[1].geometry, null); assert.equal(read.prepared.content.features[1].sourceAssessment.level, null);
  assert.equal(read.prepared.content.features[0].provenance.origin.firstRecordedAt, publishedAt);
  f.advance(60000); f.reset(); assert.equal((await ensurePreparedScene(f.env, 'gdacs', { now: f.now, readInput: () => assert.fail('same GDACS basis rebuilt') })).status, 'ready');
  assert.equal(f.activity.objects.some(row => row.operation === 'put'), false); assert.equal(f.activity.providers.length, 0);
});

test('a crash between prior promotion and current write keeps the old edition and resumes only against the actual new head', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now });
  const first = f.objects.get(PREPARED_SCENES_KEYS.earthquakes.current); f.advance(60001); await f.acquire(4);
  f.hook(({ operation, key }) => { if (operation === 'put' && key === PREPARED_SCENES_KEYS.earthquakes.current) throw Error('TEST ONLY simulated current write failure'); });
  const failed = await ensurePreparedScene(f.env, 'earthquakes', { now: f.now }); assert.equal(failed.status, 'pending'); assert.equal(failed.uncertain, true);
  assert.equal(pluginJson(JSON.parse(new TextDecoder().decode(f.objects.get(PREPARED_SCENES_KEYS.earthquakes.current)))), pluginJson(JSON.parse(new TextDecoder().decode(first))));
  assert.equal((await readPreparedScene(f.env, 'earthquakes', { now: f.now })).pending, true);
  f.hook(null); assert.equal((await ensurePreparedScene(f.env, 'earthquakes', { now: f.now })).status, 'prepared');
  const ready = await readPreparedScene(f.env, 'earthquakes', { now: f.now, includePrior: true });
  assert.equal(ready.prepared.content.features[0].record.mag, 4); assert.equal(ready.prior.content.features[0].record.mag, 3);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_plugin_captures').get().n, 2);
});

test('simultaneous cold readers share one bounded slot decode while independently confirming the primary source head', async t => {
  const f = await fixture(t); await f.acquire(3); await ensurePreparedScene(f.env, 'earthquakes', { now: f.now });
  const cold = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } }, started = wait(), release = wait();
  f.hook(async ({ operation, key }) => { if (operation === 'get' && key === PREPARED_SCENES_KEYS.earthquakes.current) { started.resolve(); await release.promise; } }); f.reset();
  const first = readPreparedScene(cold, 'earthquakes', { now: f.now }); await started.promise;
  const second = readPreparedScene(cold, 'earthquakes', { now: f.now }); await Promise.resolve(); await Promise.resolve(); release.resolve();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.available, true); assert.equal(b.available, true); assert.equal(a.prepared, b.prepared);
  assert.equal(f.activity.objects.filter(row => row.operation === 'get' && row.key === PREPARED_SCENES_KEYS.earthquakes.current).length, 1);
  assert.equal(f.activity.sql.filter(row => /JOIN earth_plugin_captures/.test(row.sql)).length, 4);
  assert.equal(f.activity.sql.some(row => row.write), false); assert.equal(f.activity.providers.length, 0);
});
