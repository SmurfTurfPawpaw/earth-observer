import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { appendHistorySnapshot } from './history.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { projectWorldCollection, readWorldEvents } from './world-model.js';
import { enqueueInvestigation, claimInvestigation, runInvestigationJob, readInvestigationJobs,
  readInvestigationArtifact, INVESTIGATION_LIMITS } from './investigation-jobs.js';

const CLOCK = Date.parse('2026-10-11T22:00:00.000Z'), ID = 'us7000test1';
const stamp = offset => new Date(CLOCK + offset).toISOString();
function quake(id = ID, changes = {}) {
  const normalized = normalizeUsgs({ type: 'FeatureCollection', features: [{ type: 'Feature', id,
    properties: { title: `TEST ONLY ${id}`, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      mag: Object.hasOwn(changes, 'magnitude') ? changes.magnitude : 5.1,
      time: Date.parse(changes.observedAt || stamp(-300_000)), updated: Date.parse(changes.updatedAt || stamp(-60_000)), status: 'reviewed' },
    geometry: { type: 'Point', coordinates: [changes.lon ?? 4, changes.lat ?? 50, 12] } }] }, changes.retrievedAt || stamp(0));
  assert.equal(normalized[0].id, `usgs:${id}`);
  return canonicalDiscoveryRecord(normalized[0]);
}
function detail(changes = {}) { return { type: 'Feature', id: ID,
  properties: { mag: 5.1, magType: 'mww', place: 'TEST ONLY source location', time: CLOCK - 300_000,
    updated: CLOCK - 30_000, status: 'reviewed', type: 'earthquake', felt: 12, cdi: 3.1, mmi: 4.2, tsunami: 0,
    products: { test: [{ contents: { ignored: { url: 'https://untrusted.example/do-not-follow' } } }] }, ...changes },
  geometry: { type: 'Point', coordinates: [4, 50, 12] } }; }

async function fixture(t, migrated = true) {
  let clock = CLOCK, sequence = Promise.resolve(), serial = 0;
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    assert.ok(modifier === undefined || /^[+-]\d+ seconds$/.test(modifier));
    return new Date(clock + (modifier ? Number(modifier.split(' ')[0]) * 1000 : 0)).toISOString();
  });
  for (const name of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql',
    '0003_world_evidence.sql', ...(migrated ? ['0004_world_archive_investigations.sql', '0005_investigation_queue_index.sql'] : [])])
    sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  const records = new Map();
  const store = { records, async get(key) { const value = records.get(key); return value ? { etag: value.etag,
    size: new TextEncoder().encode(value.body).byteLength, json: async () => JSON.parse(value.body), text: async () => value.body } : null; },
  async put(key, body, options = {}) { const previous = records.get(key);
    if (options.onlyIf?.get?.('if-none-match') === '*' && previous || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
    const value = { body: typeof body === 'string' ? body : new TextDecoder().decode(body), etag: String(++serial) }; records.set(key, value); return value;
  } };
  const db = { sqlite, maxBindings: 0, batches: 0,
    withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) { const bind = (...values) => { assert.ok(values.length <= 100); db.maxBindings = Math.max(db.maxBindings, values.length);
      return { sql, values, async all() { const results = sqlite.prepare(sql).all(...values);
        return { success: true, results, meta: { changes: /^(UPDATE|INSERT|DELETE)/i.test(sql.trim()) ? Number(sqlite.prepare('SELECT changes() AS n').get().n) : 0 } }; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async run() { const output = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(output.changes) } }; } };
    }; return { ...bind(), bind }; },
    batch(statements) { assert.ok(statements.length <= 25); db.batches++;
      const operation = sequence.then(async () => { sqlite.exec('BEGIN'); try {
        const output = [];
        for (const statement of statements) output.push(/^\s*SELECT/i.test(statement.sql) || /RETURNING \*/.test(statement.sql) ? await statement.all() : await statement.run());
        sqlite.exec('COMMIT'); return output;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; } });
      sequence = operation.catch(() => {}); return operation;
    },
  };
  const env = { EARTH_DB: db, EARTH_STORE: store }, now = () => clock;
  return { env, now, db, records, clock(offset) { clock = CLOCK + offset; },
    count(table) { return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); },
    async capture(offset, items = [quake()]) {
      const capture = await appendHistorySnapshot(env, { source: 'usgs', at: stamp(offset), records: items }, { now });
      const projected = await projectWorldCollection(env, { packet: { schemaVersion: 1, collectedAt: stamp(offset), payload: { indexRecords: items } }, snapshots: [capture] }, { now });
      assert.equal(projected.stored, true);
      return (await readWorldEvents(env, {}, { now })).events;
    },
    async enqueue(event, priority) { return enqueueInvestigation(env, { eventId: event.id, inputRevision: event.evidence.revision,
      ...(priority !== undefined ? { priority } : {}) }, { now }); },
  };
}

test('actual generated migration gates jobs; retained input validation creates no arbitrary source work', async t => {
  const absent = await fixture(t, false), [event] = await absent.capture(0);
  assert.deepEqual(await absent.enqueue(event), { configured: false, enqueued: false });
  const f = await fixture(t), [retained] = await f.capture(0);
  assert.equal(retained.evidence.sourceRecordId, `usgs:${ID}`);
  await assert.rejects(enqueueInvestigation(f.env, { eventId: retained.id, inputRevision: 'b'.repeat(64) }, { now: f.now }), /current retained/);
  await assert.rejects(enqueueInvestigation(f.env, { eventId: retained.id, inputRevision: retained.evidence.revision, url: 'https://untrusted.example' }), TypeError);
  assert.equal(f.count('earth_investigation_jobs'), 0);
  assert.deepEqual(await readInvestigationJobs(absent.env), { configured: false, jobs: [] });
  const plan = f.db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM earth_investigation_jobs ORDER BY created_at DESC,job_id DESC LIMIT 20').all();
  assert.ok(plan.some(row => /earth_investigation_jobs_created/.test(row.detail)));
});

test('unchanged input has one durable job and can raise priority without resetting attempts or factual pointers', async t => {
  const f = await fixture(t), [event] = await f.capture(0);
  const first = await f.enqueue(event), second = await f.enqueue(event, 7);
  assert.equal(first.job.jobId, second.job.jobId); assert.equal(second.job.priority, 7);
  assert.equal(f.count('earth_investigation_jobs'), 1); assert.equal(f.count('earth_investigation_heads'), 1);
  assert.equal(f.count('earth_investigation_attempts'), 0); assert.equal(f.count('earth_world_revisions'), 1);
  assert.equal(f.count('earth_collection_revision'), 0);
});

test('corrected input supersedes unfinished work, including captures with the same hosted recording millisecond', async t => {
  const f = await fixture(t), [original] = await f.capture(0), first = await f.enqueue(original);
  const [corrected] = await f.capture(1000, [quake(ID, { magnitude: 5.7, updatedAt: stamp(-1000) })]);
  const second = await f.enqueue(corrected);
  assert.notEqual(first.job.jobId, second.job.jobId);
  const old = f.db.sqlite.prepare('SELECT state,superseded_by FROM earth_investigation_jobs WHERE job_id=?').get(first.job.jobId);
  assert.equal(old.state, 'superseded'); assert.equal(old.superseded_by, second.job.jobId);
  const head = f.db.sqlite.prepare('SELECT job_id FROM earth_investigation_heads').get(); assert.equal(head.job_id, second.job.jobId);
  const claimed = await claimInvestigation(f.env, { workerId: 'test:corrected' }); assert.equal(claimed.job.jobId, second.job.jobId);
});

test('SQL claims prevent simultaneous owners across independent callers and retain a monotonic attempt fence', async t => {
  const f = await fixture(t), events = await f.capture(0, [quake(), quake('us7000test2')]);
  for (const event of events) await f.enqueue(event);
  const [a, b] = await Promise.all([claimInvestigation(f.env, { workerId: 'isolate:a' }), claimInvestigation({ ...f.env }, { workerId: 'isolate:b' })]);
  assert.equal([a, b].filter(value => value.job).length, 1);
  assert.equal(f.count('earth_investigation_attempts'), 1);
  const first = (a.job || b.job); f.clock(61_000);
  const next = await claimInvestigation(f.env, { workerId: 'isolate:recovery' });
  assert.ok(next.job); assert.equal(next.job.fence, next.job.jobId === first.jobId ? 2 : 1);
  assert.notEqual(next.job.leaseToken, first.leaseToken);
  assert.equal(f.db.sqlite.prepare('SELECT state FROM earth_investigation_attempts WHERE job_id=? AND fence=1').get(first.jobId).state, 'lease_expired');
});

test('one official detail roundtrip retains immutable raw evidence and an attributable artifact without product crawling', async t => {
  const f = await fixture(t), [event] = await f.capture(0), enqueued = await f.enqueue(event);
  f.clock(1000);
  let requests = 0;
  const result = await runInvestigationJob(f.env, { workerId: 'test:detail' }, { now: f.now, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${ID}.geojson`);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); return Response.json(detail({ updated: CLOCK + 500 }));
  } });
  assert.equal(result.accepted, true); assert.equal(result.job.state, 'succeeded'); assert.equal(requests, 1);
  const read = await readInvestigationArtifact(f.env, { jobId: enqueued.job.jobId });
  assert.equal(read.available, true); assert.equal(read.artifact.reportedFacts.depthKm, 12);
  assert.equal(read.artifact.reportedFacts.magnitude, 5.1);
  assert.equal(read.artifact.inputRevision, event.evidence.revision); assert.equal(read.artifact.basis.snapshotId, event.evidence.snapshotId);
  assert.equal(read.artifact.basis.sourceRecordId, `usgs:${ID}`); assert.equal(read.artifact.source.sourceRecordId, `usgs:${ID}`);
  assert.equal(read.artifact.source.providerEventId, ID); assert.equal(read.artifact.citations[0].sourceRecordId, `usgs:${ID}`);
  assert.equal(read.artifact.reportedFacts.sourceUpdatedAt, stamp(500)); assert.equal(read.artifact.acquiredAt, stamp(1000));
  assert.equal(read.artifact.citations[0].rawSha256, read.artifact.source.rawSha256);
  assert.match(read.artifact.meaning, /not knowledge available before acquisition/);
  assert.ok(f.records.has(read.artifact.source.rawKey));
  const attempts = f.db.sqlite.prepare('SELECT * FROM earth_investigation_attempts').all();
  assert.equal(attempts[0].state, 'succeeded'); assert.equal(attempts[0].raw_key, read.artifact.source.rawKey);
  assert.equal((await readInvestigationArtifact(f.env, { jobId: enqueued.job.jobId, knownAt: stamp(-1) }, { now: f.now })).available, false);
  assert.equal((await readInvestigationArtifact(f.env, { jobId: enqueued.job.jobId, knownAt: stamp(999) }, { now: f.now })).available, false);
  assert.equal((await readInvestigationArtifact(f.env, { jobId: enqueued.job.jobId, knownAt: stamp(1000) }, { now: f.now })).available, true);
  assert.equal(f.count('earth_world_revisions'), 1); assert.equal(f.count('earth_world_captures'), 1); assert.equal(f.count('earth_collection_revision'), 0);
  assert.equal((await f.enqueue(event)).job.state, 'succeeded');
  const list = await readInvestigationJobs(f.env); assert.equal(Object.hasOwn(list.jobs[0], 'leaseToken'), false);
});

test('cancellation before or during preclaim admission has no queue mutation, attempt or provider side effect', async t => {
  const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
  let fetches = 0;
  for (const alreadyAborted of [true, false]) {
    const controller = new AbortController(), batches = f.db.batches;
    if (alreadyAborted) controller.abort();
    const running = runInvestigationJob(f.env, { workerId: 'test:cancel' }, { now: f.now, signal: controller.signal,
      fetchImpl: async () => { fetches++; return Response.json(detail()); } });
    if (!alreadyAborted) controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(f.db.batches, batches); assert.equal(f.count('earth_investigation_attempts'), 0);
    assert.equal((await readInvestigationJobs(f.env)).jobs[0].state, 'pending');
  }
  assert.equal(fetches, 0);
});

test('an expired stale runner cannot complete over its replacement but its acquired artifact reference remains in the attempt journal', async t => {
  const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
  let arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; }), held = new Promise(resolve => { release = resolve; });
  const old = runInvestigationJob(f.env, { workerId: 'test:old' }, { now: f.now, fetchImpl: async () => { arrived(); await held; return Response.json(detail()); } });
  await waiting; f.clock(61_000);
  const next = await runInvestigationJob(f.env, { workerId: 'test:new' }, { now: f.now, fetchImpl: async () => Response.json(detail({ mag: 5.2 })) });
  assert.equal(next.accepted, true); assert.equal(next.job.state, 'succeeded');
  release(); const stale = await old; assert.equal(stale.accepted, false);
  const artifact = await readInvestigationArtifact(f.env, { jobId: next.job.jobId }); assert.equal(artifact.artifact.reportedFacts.magnitude, 5.2);
  const attempt = f.db.sqlite.prepare('SELECT * FROM earth_investigation_attempts WHERE fence=1').get();
  assert.equal(attempt.state, 'lease_lost'); assert.ok(attempt.raw_key); assert.ok(attempt.artifact_key);
});

test('provider Retry-After, exponential retry and attempt cap persist without immediate retry storms', async t => {
  const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
  const first = await runInvestigationJob(f.env, { workerId: 'test:retry' }, { now: f.now,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '180' } }) });
  assert.equal(first.job.state, 'retry'); assert.equal(first.job.errorCode, 'upstream_limit'); assert.equal(first.job.dueAt, stamp(180_000));
  f.clock(60_000); assert.equal((await claimInvestigation(f.env, { workerId: 'test:too-early' })).job, null);
  f.clock(180_000); const second = await runInvestigationJob(f.env, { workerId: 'test:retry' }, { now: f.now, fetchImpl: async () => new Response('', { status: 502 }) });
  assert.equal(second.job.state, 'retry'); assert.equal(second.job.dueAt, stamp(300_000));
  f.clock(300_000); const third = await runInvestigationJob(f.env, { workerId: 'test:retry' }, { now: f.now, fetchImpl: async () => new Response('', { status: 502 }) });
  assert.equal(third.job.state, 'failed'); assert.equal(third.job.attemptCount, 3);
  f.clock(600_000); assert.equal((await claimInvestigation(f.env, { workerId: 'test:exhausted' })).job, null);
  assert.equal(f.count('earth_investigation_attempts'), 3);
});

test('a correction during a running fetch fences old completion and retains its superseded attempt evidence', async t => {
  const f = await fixture(t), [original] = await f.capture(0), first = await f.enqueue(original);
  let arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; }), held = new Promise(resolve => { release = resolve; });
  const running = runInvestigationJob(f.env, { workerId: 'test:correction' }, { now: f.now, fetchImpl: async () => { arrived(); await held; return Response.json(detail()); } });
  await waiting; f.clock(1000);
  const [corrected] = await f.capture(1000, [quake(ID, { magnitude: 5.7, updatedAt: stamp(1000) })]);
  const next = await f.enqueue(corrected); release();
  const stale = await running; assert.equal(stale.accepted, false); assert.equal(stale.job.state, 'superseded');
  assert.equal(stale.job.supersededBy, next.job.jobId);
  const attempt = f.db.sqlite.prepare('SELECT state,artifact_key FROM earth_investigation_attempts WHERE job_id=?').get(first.job.jobId);
  assert.equal(attempt.state, 'superseded'); assert.ok(attempt.artifact_key);
  assert.equal((await readInvestigationArtifact(f.env, { jobId: first.job.jobId })).available, false);
  assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events[0].reportedFacts.magnitude, 5.7);
});

test('a partial immutable artifact write retains diagnostic evidence refs and cannot become a successful artifact', async t => {
  const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
  const realPut = f.env.EARTH_STORE.put.bind(f.env.EARTH_STORE);
  f.env.EARTH_STORE.put = async (key, ...args) => { if (key.startsWith('investigations/usgs-detail/artifacts/')) throw Error('TEST ONLY unavailable storage'); return realPut(key, ...args); };
  const result = await runInvestigationJob(f.env, { workerId: 'test:partial' }, { now: f.now, fetchImpl: async () => Response.json(detail()) });
  assert.equal(result.job.state, 'retry'); assert.equal(result.job.errorCode, 'storage_unavailable');
  const attempt = f.db.sqlite.prepare('SELECT raw_key,artifact_key,state FROM earth_investigation_attempts').get();
  assert.equal(attempt.state, 'failed'); assert.ok(f.records.has(attempt.raw_key)); assert.ok(attempt.artifact_key);
  assert.equal((await readInvestigationArtifact(f.env, { jobId: result.job.jobId })).available, false);
});

test('mismatched IDs and oversized detail responses fail without invented artifacts or following supplied URLs', async t => {
  for (const invalid of ['identity', 'size']) {
    const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
    const result = await runInvestigationJob(f.env, { workerId: `test:${invalid}` }, { now: f.now, fetchImpl: async url => {
      assert.equal(url, `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${ID}.geojson`);
      return Response.json(invalid === 'identity' ? { ...detail(), id: 'us7000other' } : { ...detail(), large: 'x'.repeat(INVESTIGATION_LIMITS.detailBytes) });
    } });
    assert.equal(result.job.state, invalid === 'identity' ? 'failed' : 'retry');
    assert.equal(result.job.artifactSha256, null); assert.equal([...f.records.keys()].filter(key => key.startsWith('investigations/')).length, 0);
  }
});

test('retained artifact corruption is rejected without altering source/world facts', async t => {
  const f = await fixture(t), [event] = await f.capture(0); await f.enqueue(event);
  const result = await runInvestigationJob(f.env, { workerId: 'test:integrity' }, { now: f.now, fetchImpl: async () => Response.json(detail()) });
  const row = f.db.sqlite.prepare('SELECT artifact_key FROM earth_investigation_jobs').get();
  f.records.set(row.artifact_key, { body: '{"madeUp":"cause"}', etag: 'corrupt-test' });
  await assert.rejects(readInvestigationArtifact(f.env, { jobId: result.job.jobId }), /storage_unavailable/);
  assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events[0].reportedFacts.magnitude, 5.1);
});
