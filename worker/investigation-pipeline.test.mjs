import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { appendHistorySnapshot } from './history.js';
import { projectWorldCollection, readWorldEvents } from './world-model.js';
import { advanceInvestigationPipeline, startInvestigationPipeline } from './investigation-pipeline.js';
import { createInvestigationApiHandler } from './investigation-api.js';
import { handleCollection } from './collection-api.js';
import { collectionFactsDigest } from './collection-publication.js';

const CLOCK = Date.parse('2026-10-11T22:00:00.000Z'), DAY = 86_400_000;
const stamp = offset => new Date(CLOCK + offset).toISOString();
const feature = (id, magnitude, offset) => ({ type: 'Feature', id,
  properties: { type: 'earthquake', title: `TEST ONLY ${id}`, mag: magnitude, magType: 'mww',
    time: CLOCK + offset, updated: CLOCK + offset + 1000, status: 'reviewed',
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` },
  geometry: { type: 'Point', coordinates: [4, 50, 12] } });
const inputs = () => [feature('us7000recent', 5.2, -1000), feature('us7000major', 7.2, -3600_000),
  feature('us7000second', 6.8, -7200_000), feature('us7000small', 4.7, -900_000), feature('us7000old', 8.3, -DAY - 1000)];

async function fixture(t) {
  let clock = CLOCK, sequence = Promise.resolve(), serial = 0;
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    return new Date(clock + (modifier ? Number(modifier.split(' ')[0]) * 1000 : 0)).toISOString();
  });
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
    sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
  const records = new Map(), counters = { writes: 0, puts: 0, batches: 0 };
  const store = { async get(key) { const row = records.get(key); return row ? { etag: row.etag,
    size: Buffer.byteLength(row.body), json: async () => JSON.parse(row.body), text: async () => row.body } : null; },
    async put(key, body, options = {}) { counters.puts++; const previous = records.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
      const value = { body: String(body), etag: String(++serial) }; records.set(key, value); return value;
    } };
  const db = { sqlite, withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) { const bind = (...values) => { assert.ok(values.length <= 100); return { sql, values,
      async all() { const results = sqlite.prepare(sql).all(...values), write = /^(UPDATE|INSERT|DELETE)/i.test(sql.trim());
        if (write) counters.writes++; return { success: true, results, meta: { changes: write ? Number(sqlite.prepare('SELECT changes() AS n').get().n) : 0 } }; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async run() { const result = sqlite.prepare(sql).run(...values); counters.writes++;
        return { success: true, results: [], meta: { changes: Number(result.changes) } }; } }; }; return { ...bind(), bind }; },
    batch(statements) { assert.ok(statements.length <= 25); counters.batches++;
      const operation = sequence.then(async () => { sqlite.exec('BEGIN'); try {
        const results = []; for (const statement of statements) results.push(/^\s*SELECT/i.test(statement.sql) || /RETURNING \*/.test(statement.sql) ? await statement.all() : await statement.run());
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }); sequence = operation.catch(() => {}); return operation;
    } };
  const env = { EARTH_DB: db, EARTH_STORE: store }, now = () => clock;
  let source = inputs(), fetches = [];
  return { env, now, counters, sqlite, records, clock(offset) { clock = CLOCK + offset; },
    count(table) { return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); },
    async capture(features = source) { source = features;
      const canonical = normalizeUsgs({ type: 'FeatureCollection', features }, new Date(clock).toISOString()).map(canonicalDiscoveryRecord);
      assert.ok(canonical.every(Boolean)); assert.ok(canonical.every(record => record.id.startsWith('usgs:')));
      const retained = await appendHistorySnapshot(env, { source: 'usgs', at: new Date(clock).toISOString(), records: canonical }, { now });
      assert.equal((await projectWorldCollection(env, { packet: { schemaVersion: 1, collectedAt: new Date(clock).toISOString(), payload: { indexRecords: canonical } }, snapshots: [retained] }, { now })).stored, true);
      return (await readWorldEvents(env, { limit: 100 }, { now })).events;
    },
    async fetchImpl(url, options) {
      const match = /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/feed\/v1\.0\/detail\/([a-z0-9]+)\.geojson$/.exec(url);
      assert.ok(match, 'Only the compiled official detail endpoint'); assert.equal(options.redirect, 'error');
      fetches.push(match[1]); const value = source.find(item => item.id === match[1]); assert.ok(value);
      return Response.json(value);
    }, fetches,
  };
}

test('completed factual input admits only three recent source-ranked events and one detail job without changing live publication', async t => {
  const f = await fixture(t); await f.capture();
  const revisions = f.count('earth_world_revisions'), captures = f.count('earth_world_captures');
  const result = await advanceInvestigationPipeline(f.env, { workerId: 'test:collector' }, { now: f.now, fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'advanced'); assert.equal(result.candidateCount, 3); assert.equal(result.enqueueCount, 3);
  assert.equal(result.jobStarted, true); assert.equal(result.jobAccepted, true); assert.equal(result.jobState, 'succeeded');
  assert.equal(f.count('earth_investigation_jobs'), 3); assert.deepEqual(f.fetches, ['us7000major']);
  const sourceIds = f.sqlite.prepare('SELECT source_record_id FROM earth_investigation_jobs').all().map(row => row.source_record_id).sort();
  assert.deepEqual(sourceIds, ['usgs:us7000major', 'usgs:us7000recent', 'usgs:us7000second']);
  assert.equal(f.count('earth_world_revisions'), revisions); assert.equal(f.count('earth_world_captures'), captures); assert.equal(f.count('earth_collection_revision'), 0);
  assert.ok(!JSON.stringify(result).includes('leaseToken'));
});

test('repeat sweeps reuse unchanged jobs and a later source correction supersedes its pending revision', async t => {
  const f = await fixture(t); await f.capture();
  await advanceInvestigationPipeline(f.env, { workerId: 'test:collector' }, { now: f.now, fetchImpl: f.fetchImpl });
  const previous = f.sqlite.prepare("SELECT job_id FROM earth_investigation_jobs WHERE source_record_id='usgs:us7000second'").get().job_id;
  f.clock(61_000);
  const revised = inputs().map(item => item.id === 'us7000second' ? { ...item, properties: { ...item.properties, mag: 6.9, updated: CLOCK + 60_000 } } : item);
  await f.capture(revised);
  const result = await advanceInvestigationPipeline(f.env, { workerId: 'test:collector' }, { now: f.now, fetchImpl: f.fetchImpl });
  assert.equal(result.jobState, 'succeeded'); assert.equal(f.count('earth_investigation_jobs'), 4);
  assert.equal(f.sqlite.prepare('SELECT state FROM earth_investigation_jobs WHERE job_id=?').get(previous).state, 'superseded');
  f.clock(122_000); await advanceInvestigationPipeline(f.env, { workerId: 'test:collector' }, { now: f.now, fetchImpl: f.fetchImpl });
  assert.equal(f.count('earth_investigation_jobs'), 4); assert.equal(f.count('earth_investigation_attempts'), 3);
  assert.deepEqual(f.fetches, ['us7000major', 'us7000second', 'us7000recent']);
});

test('actual authorized factual publication responds before background research; heartbeat and denied calls register no tasks', async t => {
  const f = await fixture(t), token = 'collector_fixture_'.padEnd(64, 't'); f.env.EARTH_COLLECTOR_TOKEN = token;
  const indexRecords = normalizeUsgs({ features: inputs() }, stamp(0)).map(canonicalDiscoveryRecord);
  const sources = [{ id: 'usgs', name: 'U.S. Geological Survey', url: 'https://earthquake.usgs.gov/',
    status: 'ready', stale: false, retrievedAt: stamp(0) }];
  const packet = { schemaVersion: 1, collectedAt: stamp(0), payload: { indexRecords, reports: [], sources,
    indexCoverage: { schemaVersion: 1, sources: [{ id: 'usgs', generation: stamp(0), status: 'ready',
      coverage: 'TEST ONLY retained USGS fixture', expiresAt: stamp(DAY) }] } } };
  const inputDigest = await collectionFactsDigest(indexRecords);
  const analysis = { schemaVersion: 1, method: 'deterministic-source-metadata', createdAt: stamp(0), inputDigest,
    changes: { added: indexRecords.length, revised: 0, withdrawn: 0 }, topics: [], analysis: [] };
  const post = (value, authorized = true) => new Request('https://owned.example/api/collector', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const background = [], deniedTasks = [], heartbeatTasks = [];
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { entered = resolve; });
  const fetchImpl = async (...args) => { entered(); await held; return f.fetchImpl(...args); };
  assert.equal((await handleCollection(post({ action: 'publish', packet, analysis }, false), f.env,
    { waitUntil: task => deniedTasks.push(task) }, { now: f.now, fetchImpl })).status, 401);
  assert.equal(deniedTasks.length, 0); assert.equal(f.count('earth_investigation_jobs'), 0);
  let timer;
  try {
    const response = await Promise.race([handleCollection(post({ action: 'publish', packet, analysis }), f.env,
      { waitUntil: task => background.push(task) }, { now: f.now, fetchImpl }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Factual response waited for held research')), 1000); })]);
    assert.equal(response.status, 200); const publication = await response.json();
    assert.equal(publication.stored, true); assert.equal(publication.world.stored, true);
    assert.equal(publication.research.scheduled, true); assert.equal(background.length, 1);
    await arrived;
    f.clock(1000);
    const heartbeat = await handleCollection(post({ action: 'heartbeat', collectedAt: stamp(1000), inputDigest,
      sources: sources.map(source => ({ ...source, retrievedAt: stamp(1000) })) }), f.env,
      { waitUntil: task => heartbeatTasks.push(task) }, { now: f.now, fetchImpl });
    assert.equal(heartbeat.status, 200); assert.equal((await heartbeat.json()).heartbeat, true); assert.equal(heartbeatTasks.length, 0);
  } finally { clearTimeout(timer); release(); }
  const research = await background[0]; assert.equal(research.jobState, 'succeeded'); assert.equal(research.jobAccepted, true);
  const handle = createInvestigationApiHandler({ now: f.now });
  const artifact = await handle(new Request(`https://owned.example/api/investigations/${encodeURIComponent(research.jobId)}`), f.env);
  assert.equal(artifact.status, 200); assert.equal((await artifact.json()).artifact.source.sourceRecordId, 'usgs:us7000major');
  assert.equal(f.fetches.length, 1);
});

test('waitUntil registration is prompt and shared while missing or failed registration starts no detached work', async t => {
  const f = await fixture(t); await f.capture(); const before = f.counters.writes;
  assert.deepEqual(startInvestigationPipeline(f.env, {}, { workerId: 'test:background' }), { scheduled: false, status: 'background_unavailable' });
  assert.deepEqual(startInvestigationPipeline(f.env, { waitUntil() { throw Error('TEST ONLY unavailable'); } }, { workerId: 'test:background' }), { scheduled: false, status: 'background_unavailable' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.counters.writes, before);
  const tasks = [], ctx = { waitUntil(task) { tasks.push(task); } };
  assert.deepEqual(startInvestigationPipeline(f.env, ctx, { workerId: 'test:background' }, { now: f.now, fetchImpl: f.fetchImpl }), { scheduled: true, status: 'scheduled' });
  assert.deepEqual(startInvestigationPipeline(f.env, ctx, { workerId: 'test:background' }, { now: f.now, fetchImpl: f.fetchImpl }), { scheduled: false, status: 'already_running' });
  assert.equal(tasks[0], tasks[1]); assert.equal((await tasks[0]).jobState, 'succeeded'); assert.equal(f.fetches.length, 1);
});

test('cancelled collection cannot enqueue or claim investigation work', async t => {
  const f = await fixture(t); await f.capture(); const writes = f.counters.writes;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(advanceInvestigationPipeline(f.env, { workerId: 'test:cancel' }, { now: f.now, fetchImpl: f.fetchImpl, signal: controller.signal }), { name: 'AbortError' });
  const tasks = [], live = new AbortController();
  startInvestigationPipeline(f.env, { waitUntil(task) { tasks.push(task); } }, { workerId: 'test:cancel' }, { now: f.now, fetchImpl: f.fetchImpl, signal: live.signal });
  live.abort(); assert.equal((await tasks[0]).status, 'cancelled');
  assert.equal(f.counters.writes, writes); assert.equal(f.fetches.length, 0); assert.equal(f.count('earth_investigation_jobs'), 0);
});

test('public stored routing reads jobs/artifacts and respects known time without any provider or write effects', async t => {
  const f = await fixture(t); const events = await f.capture(); f.clock(1000);
  const result = await advanceInvestigationPipeline(f.env, { workerId: 'test:api' }, { now: f.now, fetchImpl: f.fetchImpl });
  const handle = createInvestigationApiHandler({ now: f.now }), snapshot = { ...f.counters }, fetched = f.fetches.length;
  const list = await handle(new Request('https://owned.example/api/investigations?limit=20'), f.env);
  assert.equal(list.status, 200); const jobs = (await list.json()).jobs; assert.equal(jobs.length, 3); assert.equal(Object.hasOwn(jobs[0], 'leaseToken'), false);
  const event = events.find(item => item.evidence.sourceRecordId === 'usgs:us7000major');
  const filtered = await handle(new Request(`https://owned.example/api/investigations?eventId=${encodeURIComponent(event.id)}&limit=1`), f.env);
  assert.equal((await filtered.json()).jobs.length, 1);
  const endpoint = `https://owned.example/api/investigations/${encodeURIComponent(result.jobId)}`;
  const artifact = await handle(new Request(endpoint + `?knownAt=${encodeURIComponent(stamp(1000))}`), f.env);
  assert.equal(artifact.status, 200); assert.equal((await artifact.json()).artifact.source.sourceRecordId, 'usgs:us7000major');
  assert.equal((await handle(new Request(endpoint + `?knownAt=${encodeURIComponent(stamp(999))}`), f.env)).status, 404);
  assert.equal(f.counters.writes, snapshot.writes); assert.equal(f.counters.puts, snapshot.puts); assert.equal(f.fetches.length, fetched);
});

test('method, path and query boundaries reject expanded routes before stored reads', async () => {
  let reads = 0; const handle = createInvestigationApiHandler({ readJobs: async () => { reads++; return { configured: true, jobs: [] }; } });
  for (const [suffix, status] of [['?limit=21', 400], ['?limit=01', 400], ['?limit=1&limit=2', 400], ['?eventId=unknown', 400],
    ['?url=https://untrusted.example', 400], ['?knownAt=2025-01-01', 400], ['/unknown', 404]])
    assert.equal((await handle(new Request(`https://owned.example/api/investigations${suffix}`))).status, status);
  assert.equal((await handle(new Request('https://owned.example/api/investigations', { method: 'POST', body: '{"action":"collect"}' }))).status, 405);
  assert.equal(await handle(new Request('https://owned.example/api/elsewhere')), null); assert.equal(reads, 0);
});

test('public read deadline, missing storage and oversized results fail without raw internal errors', async () => {
  const missing = await createInvestigationApiHandler()(new Request('https://owned.example/api/investigations'));
  assert.equal(missing.status, 503);
  const deadline = await createInvestigationApiHandler({ deadlineMs: 5, readJobs: async () => new Promise(() => {}) })(new Request('https://owned.example/api/investigations'));
  assert.equal(deadline.status, 503);
  const tooLarge = await createInvestigationApiHandler({ readJobs: async () => ({ configured: true, jobs: [], oversized: 'x'.repeat(70_000) }) })(new Request('https://owned.example/api/investigations'));
  assert.equal(tooLarge.status, 503);
  const failed = await createInvestigationApiHandler({ readJobs: async () => { throw Error('TEST ONLY PRIVATE ERROR'); } })(new Request('https://owned.example/api/investigations'));
  assert.ok(!(await failed.text()).includes('PRIVATE ERROR'));
});
