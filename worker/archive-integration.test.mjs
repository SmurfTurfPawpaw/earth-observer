import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { usgsCatalogUrl } from '../server/hosted/usgs-catalog-interval.js';
import { ARCHIVE_SCOPE, retainWorldArchiveRaw, publishWorldArchiveChunk } from './world-archive.js';
import { bootstrapArchiveDays } from './archive-bootstrap.js';
import { runArchiveMaintenance } from './archive-maintenance.js';
import { readWorldScene, createWorldSceneHandler } from './world-scene.js';
import { createArchiveApiHandler } from './archive-api.js';
import { signArchiveImport, bootstrapUsgsArchive } from '../scripts/usgs-archive-import.mjs';
import { startArchiveMaintenance } from './archive-maintenance-runner.js';
import { createEarthRuntime } from './index.js';
import { handleCollection } from './collection-api.js';
import { archiveMaintenanceFixture } from './archive-maintenance-fixture.mjs';

const SCOPE = ARCHIVE_SCOPE.id, from = '2026-10-10T00:00:00.000Z', end = '2026-10-11T00:00:00.000Z';
const key = 'TEST_ONLY_ARCHIVE_KEY_'.padEnd(64, 'x');
const quake = (at, { id = 'test-archive-integration', mag = 5.2, updated = Date.parse(at) + 1000 } = {}) => ({ type: 'Feature', id,
  properties: { type: 'earthquake', mag, time: Date.parse(at), updated, title: `TEST ONLY earthquake ${id}`, status: 'reviewed',
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` }, geometry: { type: 'Point', coordinates: [4, 50, 12] } });
async function input(f, range, features = [], kind = 'interval') {
  const body = JSON.stringify({ type: 'FeatureCollection', metadata: { count: features.length, status: 200, generated: f.now(), url: usgsCatalogUrl('query', range).href }, features });
  const raw = await retainWorldArchiveRaw(f.env, { body });
  return { schemaVersion: 1, scopeId: SCOPE, kind, range, capturedAt: f.stamp(), expectedCount: features.length, rawSha256: raw.rawSha256,
    records: features.flatMap((feature) => normalizeUsgs({ features: [feature] }, f.stamp())).map(canonicalDiscoveryRecord) };
}
async function publish(f, range = { from, to: end }, features = [quake('2026-10-10T12:00:00.000Z')], kind = 'interval') {
  return publishWorldArchiveChunk(f.env, await input(f, range, features, kind), { now: f.now });
}
function provider(f) {
  const calls = [];
  return { calls, fetchImpl: async (value) => { const url = new URL(value); calls.push(url);
    assert.equal(url.origin, 'https://earthquake.usgs.gov');
    if (url.pathname.endsWith('/count')) return new Response('1');
    const range = { from: url.searchParams.get('starttime'), to: url.searchParams.get('endtime') };
    return Response.json({ type: 'FeatureCollection', metadata: { count: 1, status: 200, generated: f.now(), url: usgsCatalogUrl('query', range).href },
      features: [quake(range.to, { id: 'test-tail', updated: Date.parse(range.to) + 1000 })] });
  } };
}
const callback = (f) => ({ env, acquired, plan }) => publishWorldArchiveChunk(env, acquired, { now: f.now, maintenanceCommit: plan });

test('actual migration keeps legacy scenes until resumable owner bootstrap visits all receipts, including intervening manual and correction writes', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); f.advance(1000);
  await publish(f, { from: end, to: '2026-10-11T12:00:00.000Z' }, []); f.advance(1000);
  await publish(f, { from: '2026-10-11T12:00:00.000Z', to: '2026-10-11T23:59:59.999Z' }, []);
  f.sqlite.exec('DELETE FROM earth_archive_coverage_days');
  const before = await readWorldScene(f.env, { metadata: true }, { now: f.now });
  assert.equal(before.coverage.storageMode, 'legacy-receipt-index'); assert.equal(before.coverage.complete, true);
  assert.equal((await bootstrapArchiveDays(f.env, { limit: 1 })).complete, false);
  assert.equal((await readWorldScene(f.env, { metadata: true }, { now: f.now })).coverage.storageMode, 'legacy-receipt-index');
  f.advance(1000); await publish(f, { from: '2026-10-11T23:59:59.999Z', to: '2026-10-12T00:00:00.000Z' }, []);
  f.advance(1000); await publish(f, { from, to: end }, [quake('2026-10-10T12:00:00.000Z', { mag: 4.1, updated: f.now() })], 'correction');
  let done; for (let tries = 0; tries < 8 && !done?.complete; tries++) done = await bootstrapArchiveDays(f.env, { limit: 1 });
  assert.equal(done.complete, true); assert.equal(done.currentOrder, 5); assert.equal(done.frontier.seeded, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_coverage').get().n, 4);
  const after = await readWorldScene(f.env, { metadata: true }, { now: f.now }); assert.equal(after.coverage.storageMode, 'day-proof-index');
  assert.deepEqual(after.coverage.availableRange, { from, to: '2026-10-12T00:00:00.000Z' }); assert.equal(after.coverage.complete, true);
  const receipts = f.sqlite.prepare("SELECT published_at FROM earth_archive_chunks WHERE kind='interval' ORDER BY id").all().map((row) => row.published_at);
  const proofs = f.sqlite.prepare('SELECT first_proof_json FROM earth_archive_coverage_days').all().flatMap((row) => JSON.parse(row.first_proof_json));
  assert.ok(proofs.every((piece) => receipts.includes(piece.knownAt)), 'Bootstrap proof clocks are original receipt clocks, never bootstrap wall time');
  assert.equal((await readWorldScene(f.env, { at: end, knownAt: receipts[0] }, { now: f.now })).events[0].reportedFacts.magnitude, 5.2);
  assert.equal((await readWorldScene(f.env, { at: end }, { now: f.now })).events.length, 0, 'The retained below-threshold correction removes current reconstruction membership');
});
test('actual publisher rejects a replaced lease before admission, then resumes its exact frozen original and atomically promotes source head/day/frontier', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); await bootstrapArchiveDays(f.env);
  const p = provider(f); let expired = false;
  f.env.EARTH_DB.beforeBatch = (statements) => { if (!expired && /UPDATE earth_archive_maintenance SET admitted_chunk_id/.test(statements[0]?.sql)) { expired = true; f.advance(61000); } };
  const failure = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: callback(f) });
  assert.equal(failure.status, 'uncertain'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n, 1); assert.equal(f.state().verified_through, end);
  const original = JSON.parse(f.state().candidate_json).tail;
  f.env.EARTH_DB.beforeBatch = null;
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: () => assert.fail('Actual frozen retry cannot refetch source'), publishPrepared: callback(f) });
  assert.equal(result.status, 'stored'); assert.equal(result.chunkId, original.chunkId); assert.equal(p.calls.length, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n, 2);
  const receipt = f.sqlite.prepare('SELECT * FROM earth_archive_chunks WHERE chunk_id=?').get(result.chunkId);
  assert.equal(receipt.captured_at, original.capturedAt); assert.equal(f.state().verified_through, original.range.to);
  assert.equal((await readWorldScene(f.env, { metadata: true }, { now: f.now })).coverage.storageMode, 'day-proof-index');
  for (const table of ['earth_world_sources', 'earth_world_captures', 'earth_collection_revision']) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});
test('actual final batch rolls back receipt/head/day/frontier together; generation conflict retries one same-body publication only', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); await bootstrapArchiveDays(f.env); const p = provider(f);
  const failed = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: ({ env, acquired, plan }) =>
    publishWorldArchiveChunk(env, acquired, { now: f.now, maintenanceCommit: { ...plan, completionStatement: env.EARTH_DB.prepare('INSERT INTO TEST_ONLY_MISSING_TABLE VALUES (1)') } }) });
  assert.equal(failed.status, 'uncertain'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n, 1); assert.equal(f.state().verified_through, end); f.advance(600000);
  let races = 0, attempts = 0;
  f.env.EARTH_DB.beforeBatch = (statements) => { if (!races && /UPDATE earth_archive_maintenance SET admitted_chunk_id/.test(statements[0]?.sql)) {
    races++; f.sqlite.prepare("UPDATE earth_archive_coverage_days SET generation=generation+1 WHERE day='2026-10-11'").run(); } };
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: () => assert.fail('Generation retry uses frozen source bytes'), publishPrepared: (args) => { attempts++; return callback(f)(args); } });
  assert.equal(result.status, 'stored'); assert.equal(attempts, 2); assert.equal(races, 1); assert.equal(p.calls.length, 2);
});
test('actual transaction continues after admitted lease expiry using its receipt clock for all new day proof', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); await bootstrapArchiveDays(f.env); const p = provider(f); let advanced = false;
  f.env.EARTH_DB.afterStatement = ({ sql }) => { if (!advanced && /UPDATE earth_archive_maintenance SET admitted_chunk_id/.test(sql)) { advanced = true; f.advance(61000); } };
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: callback(f) }); assert.equal(result.status, 'stored');
  const receipt = f.sqlite.prepare('SELECT * FROM earth_archive_chunks WHERE chunk_id=?').get(result.chunkId);
  assert.equal(receipt.published_at, f.stamp()); assert.equal(f.state().lease_token, null);
  const proof = JSON.parse(f.sqlite.prepare("SELECT first_proof_json FROM earth_archive_coverage_days WHERE day='2026-10-11'").get().first_proof_json);
  assert.equal(proof.at(-1).knownAt, receipt.published_at);
});
test('calendar windows retain advertised global origins, localize gaps, validate both canonical endpoints and keep knowledge cutoff independent', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); const published = await publish(f); await bootstrapArchiveDays(f.env);
  const handle = createWorldSceneHandler({ env: f.env, now: f.now });
  const url = (params) => new Request(`https://owned.example/api/world/scene?${new URLSearchParams(params)}`);
  const params = { metadata: '1', calendarFrom: '2026-10-09T00:00:00.000Z', calendarTo: end };
  const response = await handle(url(params)); assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.coverage.availableRange, { from, to: end }); assert.equal(body.coverage.requestedRange.from, params.calendarFrom);
  assert.deepEqual(body.coverage.gaps, [{ from: params.calendarFrom, to: '2026-10-09T23:59:59.999Z', status: 'not-imported' }]);
  const earlier = await (await handle(url({ ...params, knownAt: new Date(Date.parse(published.publishedAt) - 1).toISOString() }))).json();
  assert.ok(earlier.coverage.gaps.some((gap) => gap.status === 'unavailable-at-cutoff')); assert.deepEqual(earlier.coverage.availableRange, body.coverage.availableRange);
  for (const invalid of [{ metadata: '1', calendarFrom: from }, { ...params, calendarTo: '2026-10-09T00:00:00.000Z', calendarFrom: end },
    { ...params, calendarFrom: '2026-10-09T00:00:00Z' }, { ...params, calendarTo: '2026-10-13T00:00:00.000Z' },
    { ...params, calendarFrom: '2024-01-01T00:00:00.000Z' }, { ...params, metadata: '0' }, { ...params, metadata: undefined, at: end }])
    assert.equal((await handle(url(Object.fromEntries(Object.entries(invalid).filter(([, value]) => value !== undefined))))).status, 400);
});
test('bootstrap shares signed owner authorization, fixed stored-only body and redacted CLI summary; visitor reads start no background collection', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); f.env.EARTH_ARCHIVE_IMPORT_KEY = key;
  const handle = createArchiveApiHandler({ now: f.now });
  const request = (body, { origin = false, signingKey = key } = {}) => { const text = JSON.stringify(body); return new Request('https://owned.example/api/world/archive/import', {
    method: 'POST', headers: { ...signArchiveImport(signingKey, text, { now: f.now() }), ...(origin ? { origin: 'https://owned.example' } : {}) }, body: text }); };
  const action = { schemaVersion: 1, scopeId: SCOPE, operation: 'bootstrap', limit: 16 };
  assert.equal((await handle(request(action, { origin: true }), f.env)).status, 401);
  assert.equal((await handle(request(action, { signingKey: 'wrong_'.padEnd(64, 'y') }), f.env)).status, 401);
  assert.equal((await handle(request({ ...action, url: 'https://unreviewed.example' }), f.env)).status, 400);
  const summary = await bootstrapUsgsArchive({ key, now: f.now, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).pathname, '/earth/api/world/archive/import'); return handle(new Request('https://owned.example/api/world/archive/import', options), f.env); } });
  assert.equal(summary.complete, true); assert.equal(summary.frontierSeeded, true); assert.ok(!JSON.stringify(summary).includes(key));
  const runtime = createEarthRuntime({ fetchImpl: () => assert.fail('Stored public scene cannot acquire providers') }), tasks = [];
  const response = await runtime.fetch(new Request('https://owned.example/earth/api/world/scene?metadata=1'), f.env, { waitUntil: (task) => tasks.push(task) });
  assert.equal(response.status, 200); assert.equal(tasks.length, 0); runtime.close();
  const unsupported = startArchiveMaintenance(f.env, {}, { now: f.now, fetchImpl: () => assert.fail('Unsupported background host cannot acquire') });
  assert.equal(unsupported.scheduled, false);
  const p = provider(f); startArchiveMaintenance(f.env, { waitUntil: (task) => tasks.push(task) }, { now: f.now, fetchImpl: p.fetchImpl });
  await Promise.all(tasks); assert.equal(p.calls.length, 2); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 2);
});

test('real signed collect action starts the due archive even when original packet publication fails, while denied actions and public status stay read-only', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); await bootstrapArchiveDays(f.env);
  f.env.EARTH_COLLECTOR_TOKEN = 'TEST_ONLY_COLLECTOR_TOKEN_'.padEnd(64, 't');
  const tasks = [], p = provider(f), ctx = { waitUntil: (task) => tasks.push(task) };
  const fetchImpl = (url, options) => new URL(url).pathname.startsWith('/fdsnws/event/1/') ? p.fetchImpl(url, options) : Promise.reject(new Error('TEST ONLY unrelated feeds unavailable'));
  const make = (token) => new Request('https://owned.example/api/collector', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{"action":"collect"}' });
  assert.equal((await handleCollection(make('wrong'.padEnd(64, 'x')), f.env, ctx, { now: f.now, fetchImpl })).status, 401); assert.equal(tasks.length, 0);
  await handleCollection(new Request('https://owned.example/api/collector/status'), f.env, ctx, { now: f.now, fetchImpl }); assert.equal(tasks.length, 0);
  const originalPut = f.env.EARTH_STORE.put;
  f.env.EARTH_STORE.put = async (name, body) => { if (/prepared|collector\/current/.test(name)) throw new Error('TEST ONLY prepared packet unavailable'); return originalPut(name, body); };
  const response = await handleCollection(make(f.env.EARTH_COLLECTOR_TOKEN), f.env, ctx, { now: f.now, fetchImpl });
  await Promise.all(tasks); assert.equal(p.calls.length, 2); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 2);
  assert.equal(response.status, 503); assert.equal(f.state().verified_through, '2026-10-12T00:00:00.000Z');
});

test('large existing receipt journal resumes bootstrap and switches only at the exact edition; indexed version queries preserve a nonmonotonic knowledge cutoff', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f, { from, to: end }, []);
  const base = f.sqlite.prepare('SELECT * FROM earth_archive_chunks').get();
  f.sqlite.exec('BEGIN'); for (let n = 2; n <= 2100; n++) {
    const hash = n.toString(16).padStart(64, '0'), publishedAt = new Date(f.now() + n).toISOString();
    f.sqlite.prepare(`INSERT INTO earth_archive_chunks(scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
      VALUES (?,?,?,?,?,?,'interval',0,'{}')`).run(SCOPE, hash, base.snapshot_id, base.raw_sha256, base.captured_at, publishedAt);
    f.sqlite.prepare('INSERT INTO earth_archive_coverage VALUES (?,?,?,?,0)').run(SCOPE, hash, from, end);
  } f.sqlite.exec('COMMIT'); f.advance(10000); f.sqlite.exec('DELETE FROM earth_archive_coverage_days');
  const before = await readWorldScene(f.env, { metadata: true }, { now: f.now }); assert.equal(before.available, true);
  assert.equal(before.coverage.storageMode, 'legacy-receipt-index'); assert.deepEqual(before.coverage.availableRange, { from, to: end });
  let result = await bootstrapArchiveDays(f.env, { limit: 16 }); assert.equal(result.complete, false); assert.equal(result.materializedOrder, 16);
  const partial = await readWorldScene(f.env, { metadata: true }, { now: f.now }); assert.equal(partial.coverage.storageMode, 'legacy-receipt-index');
  for (let tries = 0; tries < 140 && !result.complete; tries++) result = await bootstrapArchiveDays({ ...f.env }, { limit: 16 });
  assert.equal(result.complete, true); assert.equal(result.materializedOrder, 2100);
  f.activity.length = 0;
  const after = await readWorldScene(f.env, { metadata: true }, { now: f.now }); assert.equal(after.coverage.storageMode, 'day-proof-index'); assert.equal(after.coverage.complete, true);
  assert.equal(f.activity.some((row) => /FROM earth_archive_coverage v/.test(row.sql)), false, 'Ready public coverage no longer scans 2,100 receipts');
  const indexed = f.activity.find((row) => /WITH current AS/.test(row.sql)); assert.ok(indexed);
  const plans = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${indexed.sql}`).all(...indexed.values).map((row) => row.detail);
  assert.ok(plans.some((plan) => /SEARCH.*earth_archive_chunks_scope_order/.test(plan))); assert.ok(plans.some((plan) => /SEARCH.*earth_archive_chunks_scope_publication/.test(plan)));
  assert.equal(indexed.sql.includes('MAX(CASE'), false, 'Version selection no longer aggregates the whole journal for ordinary current/early cutoffs');
  t.diagnostic(`2,100-receipt scope-state native plan: ${[...new Set(plans.filter((plan) => /SEARCH.*earth_archive_chunks_scope_/.test(plan)))].join('; ')}. No browser/GPU timing claim.`);
  // An intentionally nonmonotonic synthetic DB clock must not turn highest ID
  // into historical knowledge. No provider timestamps are rewritten in this test.
  f.sqlite.prepare('UPDATE earth_archive_chunks SET published_at=? WHERE id=2100').run('2026-10-12T04:20:00.000Z');
  const cutoff = '2026-10-12T04:00:00.050Z', historical = await readWorldScene(f.env, { metadata: true, knownAt: cutoff }, { now: () => Date.parse('2026-10-12T05:00:00.000Z') });
  assert.equal(historical.currentVersion, 'archive:2100'); assert.equal(historical.version, 'archive:50');
});

test('a proved calendar beyond 736 days retains full seek limits while its default and explicit calendar windows stay bounded', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }), start = Date.parse('2023-10-01T00:00:00.000Z');
  for (let index = 0; index < 24; index++) {
    await publish(f, { from: new Date(start + index * 32 * 86400000).toISOString(), to: new Date(start + (index + 1) * 32 * 86400000).toISOString() }, []); f.advance(1);
  }
  let bootstrap = await bootstrapArchiveDays(f.env); if (!bootstrap.complete) bootstrap = await bootstrapArchiveDays(f.env);
  assert.equal(bootstrap.complete, true); assert.equal(bootstrap.frontier.seeded, true);
  const handle = createWorldSceneHandler({ env: f.env, now: f.now });
  const global = await handle(new Request('https://owned.example/api/world/scene?metadata=1')), checked = await global.json();
  assert.equal(global.status, 200); assert.equal(checked.available, true); assert.equal(checked.complete, true); assert.equal(checked.truncated, false);
  assert.equal(checked.coverage.availableRange.from, '2023-10-01T00:00:00.000Z');
  assert.equal(checked.coverage.dayRows, 736);
  assert.ok(checked.coverage.requestedRange.from > checked.coverage.availableRange.from, 'Loaded calendar coverage is bounded without narrowing old-date navigation');
  assert.deepEqual(checked.coverage.segments, [checked.coverage.requestedRange]);
  const url = new URL('https://owned.example/api/world/scene');
  for (const [name, value] of Object.entries({ metadata: '1', calendarFrom: '2024-01-01T00:00:00.000Z', calendarTo: '2024-02-01T00:00:00.000Z' })) url.searchParams.set(name, value);
  const response = await handle(new Request(url)), body = await response.json(); assert.equal(response.status, 200); assert.equal(body.complete, true);
  assert.equal(body.coverage.availableRange.from, '2023-10-01T00:00:00.000Z'); assert.equal(body.coverage.dayRows, 32);
  assert.equal(body.coverage.requestedRange.from, '2024-01-01T00:00:00.000Z');
});

test('a bounded wake deadline releases ownership while late publisher settlement cannot admit a new receipt', async (t) => {
  const f = await archiveMaintenanceFixture(t, { actualMigration: true }); await publish(f); await bootstrapArchiveDays(f.env); const p = provider(f);
  let release, entered, late;
  const held = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  const operation = runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, deadlineMs: 100, publishPrepared: (args) => {
    entered(); late = held.then(() => callback(f)(args)); return late;
  } });
  await started; const result = await operation; assert.equal(result.status, 'uncertain'); assert.equal(f.state().lease_token, null);
  assert.equal(f.state().verified_through, end); release(); await assert.rejects(late, /ownership|admission/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n, 1); assert.equal(p.calls.length, 2);
});


test('a regressed authoritative publication clock defers a new receipt atomically and keeps its original frozen candidate for retry', async (t) => {
  const f=await archiveMaintenanceFixture(t,{actualMigration:true}); await publish(f); await bootstrapArchiveDays(f.env); f.advance(120000);
  const before=f.sqlite.prepare('SELECT * FROM earth_archive_chunks').all(), days=f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days').all();
  const p=provider(f); let regressed=false;
  f.env.EARTH_DB.beforeBatch=(statements)=>{ if(!regressed && /UPDATE earth_archive_maintenance SET admitted_chunk_id/.test(statements[0]?.sql)) {
    regressed=true; f.setClock('2026-10-12T03:59:59.000Z');
  }};
  const result=await runArchiveMaintenance(f.env,{now:f.now,fetchImpl:p.fetchImpl,publishPrepared:callback(f)});
  assert.equal(result.status,'uncertain'); assert.equal(regressed,true); assert.equal(p.calls.length,2);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_archive_chunks').all(),before);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days').all(),days);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n,1);
  assert.equal(f.state().verified_through,end); assert.equal(f.state().lease_token,null);
  const frozen=JSON.parse(f.state().candidate_json).tail; assert.ok(frozen);
  assert.equal(frozen.capturedAt,'2026-10-12T04:02:00.000Z');
  f.env.EARTH_DB.beforeBatch=null; f.setClock('2026-10-12T04:10:00.000Z');
  const retried=await runArchiveMaintenance(f.env,{now:f.now,fetchImpl:()=>assert.fail('Clock recovery must reuse the exact retained source body'),publishPrepared:callback(f)});
  assert.equal(retried.status,'stored'); assert.equal(retried.chunkId,frozen.chunkId); assert.equal(p.calls.length,2);
  const receipt=f.sqlite.prepare('SELECT captured_at,published_at FROM earth_archive_chunks WHERE chunk_id=?').get(frozen.chunkId);
  assert.equal(receipt.captured_at,frozen.capturedAt); assert.equal(receipt.published_at,f.stamp());
});
