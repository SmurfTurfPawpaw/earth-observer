import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { appendHistorySnapshot } from './history.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { worldRevision, WORLD_MODEL_LIMITS } from '../src/core/world-model.js';
import { projectWorldCollection, readWorldEvents, readWorldSourceItems, createWorldModelHandler } from './world-model.js';
import { normalizeGdacsSourceItems, GDACS_SOURCE_ITEM_LIMITS } from '../src/core/gdacs-source-items.js';

const CLOCK = Date.parse('2026-10-11T12:00:00.000Z'), stamp = (offset = 0) => new Date(CLOCK + offset).toISOString();
const quake = (id = 'TEST_ONLY_USGS_001', changes = {}) => canonicalDiscoveryRecord({ id, sourceId: 'usgs', source: 'USGS',
  category: 'disasters', kind: 'hazard-report', title: `TEST ONLY — ${id}`, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
  eventType: 'EQ', lat: 50, lon: 4, magnitude: 5.1, observedAt: stamp(-300000), updatedAt: stamp(-60000), retrievedAt: stamp(),
  verification: 'Original source report; not independently verified.', ...changes });
const request = (query = '', options) => new Request(`https://owned.example/api/world/events${query}`, options);
const notice = (id = 'gdacs:FL:1001:1', changes = {}) => canonicalDiscoveryRecord({ id, sourceId: 'gdacs', source: 'GDACS',
  category: 'disasters', kind: 'hazard-report', title: 'TEST ONLY flood notice', url: 'https://www.gdacs.org/report.aspx?eventid=' + id.split(':')[2] + '&eventtype=' + id.split(':')[1] + '&episodeid=' + id.split(':')[3],
  eventType: id.split(':')[1], lat: 50, lon: 4, observedAt: stamp(-86400000), eventEndAt: stamp(86400000),
  updatedAt: stamp(-60000), retrievedAt: stamp(), alertLevel: 'Orange', verification: 'Modeled notice; not observed impacts.', ...changes });
const sourceRequest = (query = '?source=gdacs', options) => new Request(`https://owned.example/api/world/source-items${query}`, options);

function bucket() {
  const records = new Map(); let serial = 0;
  return { records, puts: 0, gets: 0,
    async get(key) { this.gets++; const value = records.get(key); return value ? { etag: value.etag,
      size: new TextEncoder().encode(value.body).byteLength, json: async () => JSON.parse(value.body) } : null; },
    async put(key, body, options = {}) {
      this.puts++; const previous = records.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
      const value = { body: typeof body === 'string' ? body : new TextDecoder().decode(body), etag: String(++serial) };
      records.set(key, value); return value;
    },
  };
}

async function database(t, migrated = true, now = Date.now) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    if (modifier !== undefined) assert.equal(modifier, '+305 seconds');
    return new Date(now() + (modifier === undefined ? 0 : 305000)).toISOString();
  });
  const filenames = ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql', ...(migrated ? ['0003_world_evidence.sql'] : [])];
  for (const filename of filenames) sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  const counters = { statements: 0, batches: 0, maxBindings: 0, primary: 0, maxJsonBytes: 0 };
  const db = { sqlite, counters, beforeBatch: null,
    withSession(value) { assert.equal(value, 'first-primary'); counters.primary++; return this; },
    prepare(sql) {
      const bind = (...values) => { assert.ok(values.length <= 100, 'D1 parameter ceiling'); counters.maxBindings = Math.max(counters.maxBindings, values.length);
        for (const value of values) if (typeof value === 'string' && value.startsWith('[')) {
          const size = new TextEncoder().encode(value).byteLength; counters.maxJsonBytes = Math.max(counters.maxJsonBytes, size);
          assert.ok(size <= WORLD_MODEL_LIMITS.sqlJsonBytes, 'Bounded JSON1 parameter bytes');
        }
        return { sql, values,
          async all() { counters.statements++; return { success: true, results: sqlite.prepare(sql).all(...values) }; },
          async first() { counters.statements++; return sqlite.prepare(sql).get(...values) || null; },
          async run() { counters.statements++; const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        }; };
      return { ...bind(), bind };
    },
    async batch(statements) {
      assert.ok(statements.length <= 25, 'Bounded D1 batch'); counters.batches++;
      await db.beforeBatch?.(statements);
      sqlite.exec('BEGIN');
      try { const result = [];
        for (const statement of statements) result.push(/^\s*SELECT/.test(statement.sql) ? await statement.all() : await statement.run());
        sqlite.exec('COMMIT'); return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  }; return db;
}
async function fixture(t, migrated = true) {
  let clock = CLOCK, dbClock; const now = () => clock;
  const env = { EARTH_STORE: bucket(), EARTH_DB: await database(t, migrated, () => dbClock ?? clock) };
  return { env, now, setClock(offset) { clock = CLOCK + offset; },
    setDatabaseClock(offset) { dbClock = CLOCK + offset; },
    async capture(offset, records, source = 'usgs') {
      const at = stamp(offset), accepted = await appendHistorySnapshot(env, { source, at, records }, { now });
      return { packet: { schemaVersion: 1, collectedAt: at, payload: { indexRecords: records } }, snapshots: [accepted] };
    },
    count(table) { return env.EARTH_DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; },
  };
}

test('GDACS current source items cite one verified cohort while original revision knowledge stays separately qualified', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  const first = await f.capture(0, [notice()], 'gdacs'); await projectWorldCollection(f.env, first, { now: f.now });
  f.setClock(61000);
  const current = await f.capture(60000, [notice(undefined, { retrievedAt: stamp(60000) }),
    notice('gdacs:FL:1001:2', { lat: undefined, lon: undefined, retrievedAt: stamp(60000) })], 'gdacs');
  await projectWorldCollection(f.env, current, { now: f.now });
  const originKey = `history/snapshots/gdacs/${first.snapshots[0].id}.json`;
  const origin = JSON.parse(f.env.EARTH_STORE.records.get(originKey).body); origin.records[0].lat = 80;
  f.env.EARTH_STORE.records.get(originKey).body = JSON.stringify(origin);
  const gets = f.env.EARTH_STORE.gets, puts = f.env.EARTH_STORE.puts;
  const value = await readWorldSourceItems(f.env, { source: 'gdacs' }, { now: f.now });
  assert.equal(value.available, true); await normalizeGdacsSourceItems(value);
  assert.equal(f.env.EARTH_STORE.gets - gets, 1, 'No per-item origin object read occurs in the map cohort');
  assert.equal(f.env.EARTH_STORE.puts, puts, 'Public source-item delivery performs no writes');
  assert.deepEqual(value.counts, { returned: 2, mapped: 1, unmapped: 1 });
  assert.equal(value.cohort.capturedAt, stamp(60000)); assert.equal(value.cohort.publishedAt, stamp(61000));
  const retained = value.items.find(item => item.record.id === 'gdacs:FL:1001:1');
  assert.equal(retained.record.retrievedAt, stamp(60000), 'The cited current body keeps its literal retrieval date');
  assert.equal(retained.evidence.snapshotId, current.snapshots[0].id);
  assert.equal(retained.origin.snapshotId, first.snapshots[0].id);
  assert.equal(retained.origin.firstRecordedAt, stamp(1000)); assert.equal(retained.origin.bodyValidated, false);
  assert.equal(value.operational.checkedAt, null); assert.equal(value.history.replay, false);
  assert.equal(f.count('earth_world_revisions'), 2); assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events.length, 0);
});

test('GDACS fixed public route rejects foreign/date/arbitrary inputs and has no provider or write fallback', async (t) => {
  const f = await fixture(t); f.setClock(1000); await projectWorldCollection(f.env, await f.capture(0, [notice()], 'gdacs'), { now: f.now });
  const handle = createWorldModelHandler({ env: f.env, now: f.now }), puts = f.env.EARTH_STORE.puts;
  let providerCalls = 0; const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { providerCalls++; throw new Error('TEST ONLY forbidden provider acquisition'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  assert.equal((await handle(sourceRequest())).status, 200);
  for (const query of ['', '?source=', '?source=usgs', '?source=gdacs&source=gdacs', '?source=gdacs&knownAt=' + stamp(),
    '?source=gdacs&limit=1', '?source=gdacs&url=https://www.gdacs.org/', '?source=gdacs&at=' + stamp()])
    assert.equal((await handle(sourceRequest(query))).status, 400, query);
  assert.equal((await handle(sourceRequest('?source=gdacs', { method: 'POST' }))).status, 405);
  const missing = await fixture(t, false);
  assert.equal((await createWorldModelHandler({ env: missing.env, now: missing.now })(sourceRequest())).status, 503);
  assert.equal(providerCalls, 0); assert.equal(f.env.EARTH_STORE.puts, puts);
});

test('GDACS changed current cohort retries exactly once and never combines notices from different completed receipts', async (t) => {
  for (const changes of [1, 2]) {
    const f = await fixture(t); f.setClock(1000); await projectWorldCollection(f.env, await f.capture(0, [notice()], 'gdacs'), { now: f.now });
    const originalGet = f.env.EARTH_STORE.get.bind(f.env.EARTH_STORE); let inWriter = false, bodyReads = 0;
    f.env.EARTH_STORE.get = async (key) => {
      if (!inWriter && key.startsWith('history/snapshots/gdacs/')) {
        bodyReads++;
        if (bodyReads <= changes) {
          inWriter = true; const offset = bodyReads * 60000; f.setClock(offset + 1000);
          await projectWorldCollection(f.env, await f.capture(offset, [notice(undefined,
            { lat: 50 + bodyReads, retrievedAt: stamp(offset), updatedAt: stamp(offset - 1000) })], 'gdacs'), { now: f.now });
          inWriter = false;
        }
      }
      return originalGet(key);
    };
    const value = await readWorldSourceItems(f.env, { source: 'gdacs' }, { now: f.now });
    assert.equal(bodyReads, 2, 'The current edition can restart only one whole cohort read');
    if (changes === 1) {
      assert.equal(value.available, true); assert.equal(value.items[0].record.lat, 51); assert.equal(value.cohort.capturedAt, stamp(60000));
    } else {
      assert.equal(value.available, false); assert.equal(value.errorCode, 'gdacs-cohort-changed'); assert.deepEqual(value.items, []);
    }
  }
});

test('GDACS receipt versions distinguish same publication-clock heads and preserve a small authoritative database clock lead', async (t) => {
  const f = await fixture(t); f.setClock(1000); f.setDatabaseClock(1002);
  await projectWorldCollection(f.env, await f.capture(0, [notice()], 'gdacs'), { now: f.now });
  const first = await readWorldSourceItems(f.env, {}, { now: f.now }); assert.equal(first.available, true);
  assert.equal(first.cohort.publishedAt, stamp(1002)); assert.equal(first.readAt, stamp(1000), 'Read wall time does not backdate authoritative publication');
  f.setClock(61000); f.setDatabaseClock(1002);
  await projectWorldCollection(f.env, await f.capture(60000, [notice(undefined, { lat: 51, retrievedAt: stamp(60000) })], 'gdacs'), { now: f.now });
  const second = await readWorldSourceItems(f.env, {}, { now: f.now }); assert.equal(second.available, true);
  assert.equal(second.cohort.publishedAt, first.cohort.publishedAt); assert.notEqual(second.version, first.version);
  assert.equal(second.items[0].itemId, first.items[0].itemId); assert.notEqual(second.items[0].revision, first.items[0].revision);
});

test('GDACS incomplete membership, corrupted body and future origin knowledge fail closed rather than becoming an empty valid map', async (t) => {
  const f = await fixture(t); f.setClock(1000); const capture = await f.capture(0, [notice()], 'gdacs');
  await projectWorldCollection(f.env, capture, { now: f.now });
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_world_revisions SET first_recorded_at=?').run(stamp(2000));
  assert.equal((await readWorldSourceItems(f.env, {}, { now: f.now })).available, false);
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_world_revisions SET first_recorded_at=?').run(stamp(1000));
  const key = `history/snapshots/gdacs/${capture.snapshots[0].id}.json`, original = f.env.EARTH_STORE.records.get(key).body;
  const changed = JSON.parse(original); changed.records[0].lat = -50;
  f.env.EARTH_STORE.records.get(key).body = JSON.stringify(changed);
  const corrupt = await readWorldSourceItems(f.env, {}, { now: f.now }); assert.equal(corrupt.available, false); assert.deepEqual(corrupt.items, []);
  f.env.EARTH_STORE.records.get(key).body = original;
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_world_captures SET snapshot_id=?').run('a'.repeat(64));
  assert.equal((await readWorldSourceItems(f.env, {}, { now: f.now })).available, false);
});

test('GDACS record and exact byte delivery budgets never silently truncate the retained cohort', async (t) => {
  for (const scenario of ['records', 'bytes']) {
    const f = await fixture(t); f.setClock(1000);
    const notices = Array.from({ length: scenario === 'records' ? 101 : 100 }, (_, i) => notice(`gdacs:FL:${1001 + i}:1`, scenario === 'bytes' ? {
      url: 'https://www.gdacs.org/report.aspx?context=' + 'x'.repeat(1850), source: 's'.repeat(250), title: 't'.repeat(300), verification: 'v'.repeat(400), country: 'c'.repeat(100),
    } : {}));
    assert.equal((await projectWorldCollection(f.env, await f.capture(0, notices, 'gdacs'), { now: f.now })).stored, true);
    const value = await readWorldSourceItems(f.env, {}, { now: f.now });
    assert.equal(value.available, false); assert.deepEqual(value.items, []);
    if (scenario === 'bytes') assert.equal(value.errorCode, 'gdacs-cohort-byte-budget');
  }
});

test('GDACS a bounded source read deadline cancels further work, while a genuinely empty retained cohort remains qualified', async (t) => {
  const f = await fixture(t); f.setClock(1000); await projectWorldCollection(f.env, await f.capture(0, [notice()], 'gdacs'), { now: f.now });
  let reads = 0; f.env.EARTH_STORE.get = () => { reads++; return new Promise(() => {}); };
  const began = performance.now(), value = await readWorldSourceItems(f.env, {}, { now: f.now, deadlineMs: 15 });
  assert.equal(value.errorCode, 'gdacs-source-read-timeout'); assert.equal(value.available, false); assert.equal(reads, 1);
  assert.ok(performance.now() - began < 500, 'No storage timeout or second read outlives the request budget');
  const empty = await fixture(t); empty.setClock(1000); await projectWorldCollection(empty.env, await empty.capture(0, [], 'gdacs'), { now: empty.now });
  const cohort = await readWorldSourceItems(empty.env, {}, { now: empty.now }); assert.equal(cohort.available, true);
  assert.deepEqual(cohort.counts, { returned: 0, mapped: 0, unmapped: 0 }); assert.equal(cohort.coverage.completeProviderArchive, false);
  assert.ok(new TextEncoder().encode(JSON.stringify(cohort)).byteLength < GDACS_SOURCE_ITEM_LIMITS.bytes);
});

test('GDACS pre-aborted public requests open no session or storage work and preserve the caller cancellation', async (t) => {
  const f = await fixture(t), owner = new AbortController();
  const reason = new DOMException('TEST ONLY cancelled before stored read', 'AbortError'); owner.abort(reason);
  const before = { ...f.env.EARTH_DB.counters }, gets = f.env.EARTH_STORE.gets, puts = f.env.EARTH_STORE.puts;
  const handle = createWorldModelHandler({ env: f.env, now: f.now });
  await assert.rejects(handle(sourceRequest('?source=gdacs', { signal: owner.signal })), error => error === reason);
  assert.deepEqual(f.env.EARTH_DB.counters, before, 'No primary session, schema batch or SQL query is dispatched');
  assert.equal(f.env.EARTH_STORE.gets, gets); assert.equal(f.env.EARTH_STORE.puts, puts);
});

test('GDACS caller cancellation during a body read prevents downstream revision work or an edition retry', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  await projectWorldCollection(f.env, await f.capture(0, [notice()], 'gdacs'), { now: f.now });
  const owner = new AbortController(), began = Promise.withResolvers(), late = Promise.withResolvers(); let reads = 0;
  f.env.EARTH_STORE.get = async () => { reads++; began.resolve(); return late.promise; };
  const before = f.env.EARTH_DB.counters.statements, puts = f.env.EARTH_STORE.puts;
  const handle = createWorldModelHandler({ env: f.env, now: f.now });
  const pending = handle(sourceRequest('?source=gdacs', { signal: owner.signal })); await began.promise;
  const reason = new DOMException('TEST ONLY cancelled pending body', 'AbortError'); owner.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(reads, 1); assert.equal(f.env.EARTH_DB.counters.statements - before, 1, 'Only the admitted current pointer lookup precedes the aborted body');
  late.resolve(null); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(f.env.EARTH_DB.counters.statements - before, 1);
  assert.equal(f.env.EARTH_STORE.puts, puts, 'Cancellation never writes or admits further work');
});

test('generated D1 migration and retained R2 evidence produce a bounded provisional event without new R2 writes', async (t) => {
  const f = await fixture(t); f.setClock(1000); const accepted = await f.capture(0, [quake()]), puts = f.env.EARTH_STORE.puts;
  const result = await projectWorldCollection(f.env, accepted, { now: f.now });
  assert.equal(result.stored, true); assert.equal(result.revisionCount, 1); assert.equal(result.eventCount, 1); assert.equal(result.jobCount, 0);
  assert.equal(f.env.EARTH_STORE.puts, puts); assert.equal(f.count('earth_world_captures'), 1);
  const value = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(value.events.length, 1); assert.equal(value.events[0].reportedFacts.magnitude, 5.1);
  assert.equal(value.events[0].knowledge.firstRecordedAt, stamp(1000)); assert.equal(value.events[0].capture.publishedAt, stamp(1000));
  assert.equal(value.events[0].eventTime.at, stamp(-300000)); assert.equal(value.events[0].sourceTimes.retrievedAt, stamp());
  assert.equal(value.coverage.recordCount, 1); assert.match(value.coverage.scope, /not all world events/); assert.ok(f.env.EARTH_DB.counters.primary >= 2);
});

test('unchanged checks add one source receipt while keeping first source dates and revision knowledge', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  await projectWorldCollection(f.env, await f.capture(0, [quake()]), { now: f.now });
  f.setClock(61000); const next = await f.capture(60000, [quake(undefined, { retrievedAt: stamp(60000) })]);
  const result = await projectWorldCollection(f.env, next, { now: f.now });
  assert.equal(result.revisionCount, 0); assert.equal(f.count('earth_world_revisions'), 1); assert.equal(f.count('earth_world_observations'), 1);
  assert.equal(f.count('earth_world_captures'), 2);
  await projectWorldCollection(f.env, next, { now: f.now }); assert.equal(f.count('earth_world_captures'), 2);
  const value = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(value.events[0].sourceTimes.retrievedAt, stamp()); assert.equal(value.events[0].knowledge.firstRecordedAt, stamp(1000));
  assert.equal(value.events[0].capture.capturedAt, stamp(60000));
});

test('corrections retain stable identity and as-known cutoff excludes unpublished or later facts', async (t) => {
  const f = await fixture(t); f.setClock(1000); await projectWorldCollection(f.env, await f.capture(0, [quake()]), { now: f.now });
  const original = (await readWorldEvents(f.env, {}, { now: f.now })).events[0];
  f.setClock(120000); const correction = await f.capture(60000, [quake(undefined, { magnitude: 5.7, updatedAt: stamp(59000), retrievedAt: stamp(60000) })]);
  const beforePublish = await readWorldEvents(f.env, { knownAt: stamp(90000) }, { now: f.now });
  assert.equal(beforePublish.events[0].reportedFacts.magnitude, 5.1);
  await projectWorldCollection(f.env, correction, { now: f.now });
  const historical = await readWorldEvents(f.env, { knownAt: stamp(90000) }, { now: f.now });
  assert.equal(historical.events[0].reportedFacts.magnitude, 5.1);
  const current = (await readWorldEvents(f.env, {}, { now: f.now })).events[0];
  assert.equal(current.id, original.id); assert.equal(current.place.id, original.place.id);
  assert.equal(current.reportedFacts.magnitude, 5.7); assert.notEqual(current.evidence.revision, original.evidence.revision);
  assert.equal(f.count('earth_world_revisions'), 2);
  const beforeFirst = await readWorldEvents(f.env, { knownAt: stamp(500) }, { now: f.now });
  assert.equal(beforeFirst.events.length, 0); assert.equal(beforeFirst.coverage.capturedAt, null);
});

test('late completion cannot replace newer whole-source membership and sample absence is not an ending', async (t) => {
  const f = await fixture(t); f.setClock(181000);
  const early = await f.capture(0, [quake()]);
  await projectWorldCollection(f.env, await f.capture(180000, []), { now: f.now });
  await projectWorldCollection(f.env, early, { now: f.now });
  const current = await readWorldEvents(f.env, {}, { now: f.now }); assert.equal(current.events.length, 0);
  const watermark = f.env.EARTH_DB.sqlite.prepare('SELECT captured_at FROM earth_world_sources WHERE source_id = ?').get('usgs');
  assert.equal(watermark.captured_at, stamp(180000));
  const { itemId } = await worldRevision(quake()), handle = createWorldModelHandler({ env: f.env, now: f.now });
  const absent = await handle(request(`/event:usgs:${itemId.slice(5)}`)); assert.equal(absent.status, 404);
  assert.match((await absent.json()).error, /does not establish it ended/);
});

test('A to B to A reuses factual revisions but selects authoritative whole-snapshot membership', async (t) => {
  const f = await fixture(t); f.setClock(1000); const a = await f.capture(0, [quake()]);
  await projectWorldCollection(f.env, a, { now: f.now });
  f.setClock(61000); await projectWorldCollection(f.env, await f.capture(60000, [quake(undefined, { magnitude: 5.7, updatedAt: stamp(59000) })]), { now: f.now });
  f.setClock(121000); const repeated = await f.capture(120000, [quake(undefined, { retrievedAt: stamp(120000) })]);
  assert.equal(repeated.snapshots[0].id, a.snapshots[0].id);
  await projectWorldCollection(f.env, repeated, { now: f.now });
  assert.equal(f.count('earth_world_revisions'), 2); assert.equal(f.count('earth_world_observations'), 3);
  const value = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(value.events[0].reportedFacts.magnitude, 5.1); assert.equal(value.events[0].capture.capturedAt, stamp(120000));
  assert.equal(value.events[0].knowledge.firstRecordedAt, stamp(1000));
});

test('a pending changed capture finishing after a newer unchanged check cannot corrupt whole-source membership', async (t) => {
  const f = await fixture(t); f.setClock(90001);
  await projectWorldCollection(f.env, await f.capture(90000, [quake()]), { now: f.now });
  f.setClock(99100); const changed = await f.capture(99000, [quake(undefined, { magnitude: 5.7, updatedAt: stamp(98000) })]);
  let arrived, release;
  const waiting = new Promise((resolve) => { arrived = resolve; }), hold = new Promise((resolve) => { release = resolve; });
  f.env.EARTH_DB.beforeBatch = async (statements) => {
    if (statements.some((statement) => /INSERT INTO earth_world_captures/.test(statement.sql) && JSON.parse(statement.values[0])[0]?.capturedAt === stamp(99000))) {
      arrived(); await hold;
    }
  };
  const pending = projectWorldCollection(f.env, changed, { now: f.now }); await waiting;
  f.setClock(100100); const newer = await f.capture(100000, [quake(undefined, { retrievedAt: stamp(100000) })]);
  assert.equal((await projectWorldCollection(f.env, newer, { now: f.now })).stored, true);
  f.setClock(101000); release(); assert.equal((await pending).stored, true);
  const current = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(current.events[0].reportedFacts.magnitude, 5.1); assert.equal(current.events[0].capture.capturedAt, stamp(100000));
  const earlierKnowledge = await readWorldEvents(f.env, { knownAt: stamp(99500) }, { now: f.now });
  assert.equal(earlierKnowledge.events[0].reportedFacts.magnitude, 5.1); assert.equal(earlierKnowledge.events[0].capture.capturedAt, stamp(90000));
});

test('partial index retention is invisible until complete receipt and retries preserve original retained dates', async (t) => {
  const f = await fixture(t); f.setClock(1000); const records = Array.from({ length: 120 }, (_, i) => quake(`TEST_ONLY_${String(i).padStart(3, '0')}`,
    { title: `TEST ONLY — ${'Long source location description '.repeat(10)}` }));
  const accepted = await f.capture(0, records); let writes = 0;
  f.env.EARTH_DB.beforeBatch = (statements) => { if (statements.some((statement) => /INSERT INTO earth_world_revisions/.test(statement.sql)) && ++writes === 2) throw new Error('TEST ONLY interrupted second item chunk'); };
  const failed = await projectWorldCollection(f.env, accepted, { now: f.now });
  const firstRetained = f.count('earth_world_revisions');
  assert.equal(failed.stored, false); assert.ok(firstRetained > 0 && firstRetained < records.length); assert.equal(f.count('earth_world_captures'), 0);
  assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events.length, 0);
  f.setClock(90000); f.env.EARTH_DB.beforeBatch = null;
  assert.equal((await projectWorldCollection(f.env, accepted, { now: f.now })).stored, true);
  const beforeReceipt = await readWorldEvents(f.env, { knownAt: stamp(60000) }, { now: f.now }); assert.equal(beforeReceipt.events.length, 0);
  const current = await readWorldEvents(f.env, { limit: 100 }, { now: f.now }); assert.equal(current.coverage.recordCount, records.length);
  assert.equal(current.events.length, 100); assert.equal(f.count('earth_world_revisions'), records.length);
  assert.equal(f.env.EARTH_DB.sqlite.prepare('SELECT COUNT(*) AS count FROM earth_world_revisions WHERE first_recorded_at = ?').get(stamp(1000)).count, firstRetained);
  assert.ok(current.events.every((event) => event.capture.publishedAt === stamp(90000)));
});

test('stored detail checks the exact original body even when current membership cites a later changed snapshot', async (t) => {
  const f = await fixture(t); f.setClock(1000); const original = await f.capture(0, [quake()]);
  await projectWorldCollection(f.env, original, { now: f.now });
  f.setClock(61000); await projectWorldCollection(f.env, await f.capture(60000, [quake(undefined, { retrievedAt: stamp(60000) }), quake('TEST_ONLY_NEW')]), { now: f.now });
  const handle = createWorldModelHandler({ env: f.env, now: f.now }), value = await readWorldEvents(f.env, {}, { now: f.now });
  const first = value.events.find((event) => event.source.url.endsWith('TEST_ONLY_USGS_001'));
  assert.equal(first.sourceTimes.retrievedAt, stamp()); assert.equal(first.evidence.snapshotId, original.snapshots[0].id);
  assert.equal((await handle(request(`/${first.id}`))).status, 200);
  const key = `history/snapshots/usgs/${original.snapshots[0].id}.json`, body = JSON.parse(f.env.EARTH_STORE.records.get(key).body);
  body.records[0].magnitude = 8; f.env.EARTH_STORE.records.get(key).body = JSON.stringify(body);
  assert.equal((await handle(request(`/${first.id}`))).status, 503);
  assert.equal((await handle(request())).status, 200, 'the current intact body still validates list facts');
});

test('unindexed history, migration absence, conflicting captures and corrupt current evidence never report stored success', async (t) => {
  const missing = await fixture(t, false); missing.setClock(1000);
  const accepted = await missing.capture(0, [quake()]), result = await projectWorldCollection(missing.env, accepted, { now: missing.now });
  assert.equal(result.configured, false); assert.equal(result.stored, false);
  assert.equal((await createWorldModelHandler({ env: missing.env, now: missing.now })(request())).status, 503);
  const f = await fixture(t); f.setClock(1000); const value = await f.capture(0, [quake()]);
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_observations SET snapshot_id = ?').run('b'.repeat(64));
  assert.equal((await projectWorldCollection(f.env, value, { now: f.now })).stored, false); assert.equal(f.count('earth_world_captures'), 0);
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_observations SET snapshot_id = ?').run(value.snapshots[0].id);
  assert.equal((await projectWorldCollection(f.env, value, { now: f.now })).stored, true);
  f.env.EARTH_DB.sqlite.prepare('UPDATE earth_world_captures SET snapshot_id = ?').run('c'.repeat(64));
  assert.equal((await projectWorldCollection(f.env, value, { now: f.now })).stored, false);
});

test('source metadata remains retained without inventing GDELT incident geography or jobs', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  const record = canonicalDiscoveryRecord({ id: 'TEST_ONLY_GKG_001', sourceId: 'gdelt', source: 'GDELT', kind: 'topic-mention', category: 'geopolitics',
    themes: ['ARMEDCONFLICT'], url: 'https://publisher.test/TEST_ONLY', mentionedCountries: ['BE', 'LV'], indexedAt: stamp(-60000), retrievedAt: stamp() });
  const result = await projectWorldCollection(f.env, await f.capture(0, [record], 'gdelt'), { now: f.now });
  assert.equal(result.stored, true); assert.equal(result.itemCount, 1); assert.equal(result.eventCount, 0); assert.equal(result.jobCount, 0);
  const row = f.env.EARTH_DB.sqlite.prepare('SELECT event_id, event_at, projection_json FROM earth_world_revisions').get();
  assert.deepEqual({ ...row }, { event_id: null, event_at: null, projection_json: null });
  assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events.length, 0);
});

test('public reader is strictly bounded, validates queries and never acquires upstream data', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  await projectWorldCollection(f.env, await f.capture(0, Array.from({ length: 23 }, (_, i) => quake(`TEST_ONLY_${i}`))), { now: f.now });
  const puts = f.env.EARTH_STORE.puts, previousFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unpermitted provider acquisition'); }; t.after(() => { globalThis.fetch = previousFetch; });
  const handle = createWorldModelHandler({ env: f.env, now: f.now }), before = f.env.EARTH_DB.counters.statements;
  const limited = await (await handle(request('?limit=12'))).json();
  assert.equal(limited.events.length, 12); assert.equal(limited.coverage.omittedCount, 11);
  assert.equal(f.env.EARTH_DB.counters.statements - before, 2, 'one publication/window lookup plus one grouped revision read');
  for (const query of ['?knownAt=', '?knownAt=2026-02-30T00:00:00Z', '?knownAt=2027-01-01T00:00:00Z', '?limit=101', '?limit=0', '?limit=2&limit=3', '?url=https://bad.example'])
    assert.equal((await handle(request(query))).status, 400, query);
  assert.equal((await handle(request('', { method: 'POST' }))).status, 405);
  assert.equal((await handle(request('/arbitrary-key'))).status, 404);
  assert.equal(await handle(new Request('https://owned.example/unrelated')), null);
  assert.equal(calls, 0); assert.equal(f.env.EARTH_STORE.puts, puts);
});

test('maximum admitted collection uses bounded SQL groups and unchanged follow-up does not rewrite items', async (t) => {
  const f = await fixture(t); f.setClock(1000); const records = Array.from({ length: 500 }, (_, i) => quake(`TEST_ONLY_${i}`));
  const value = await f.capture(0, records), before = f.env.EARTH_DB.counters.statements;
  f.env.EARTH_DB.counters.maxBindings = 0;
  const result = await projectWorldCollection(f.env, value, { now: f.now });
  assert.equal(result.stored, true); assert.equal(result.revisionCount, 500);
  assert.ok(f.env.EARTH_DB.counters.statements - before <= 40, 'bounded whole-collection D1 budget');
  assert.equal(f.env.EARTH_DB.counters.maxBindings, 1);
  f.setClock(61000); const heartbeat = await f.capture(60000, records), nextBefore = f.env.EARTH_DB.counters.statements;
  assert.equal((await projectWorldCollection(f.env, heartbeat, { now: f.now })).revisionCount, 0);
  assert.equal(f.env.EARTH_DB.counters.statements - nextBefore, 4, 'unchanged source requires grouped state, receipts and watermark checks');
  assert.equal(f.count('earth_world_revisions'), 500); assert.equal(f.count('earth_world_observations'), 500);
  const limited = await readWorldEvents(f.env, { limit: 100 }, { now: f.now });
  assert.equal(limited.events.length, 100); assert.equal(limited.coverage.omittedCount, 400);
});

test('realistic four-source maximum carries rich evidence in bounded JSON1 batches within 25 statements', async (t) => {
  const f = await fixture(t); f.setClock(1000);
  const location = 'TEST ONLY source location with detailed descriptive metadata '.repeat(5);
  const verification = 'TEST ONLY provider metadata retained without independent corroboration or an inferred incident location. '.repeat(3);
  const records = {
    usgs: Array.from({ length: 100 }, (_, i) => quake(`TEST_ONLY_USGS_${i}`, { title: location, reviewStatus: 'reviewed', timeMeaning: 'Source-reported earthquake origin time', verification })),
    gdacs: Array.from({ length: 100 }, (_, i) => canonicalDiscoveryRecord({ id: `TEST_ONLY_GDACS_FL_${i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report',
      title: location, category: 'disasters', url: `https://www.gdacs.org/report.aspx?eventid=${i + 1000}&eventtype=FL&episodeid=1`,
      eventType: 'FL', lat: 50, lon: 4, countries: ['BE'], country: 'Belgium', alertLevel: 'Green', observedAt: stamp(-3600000), updatedAt: stamp(-60000),
      eventEndAt: stamp(3600000), retrievedAt: stamp(), timeMeaning: 'Source notice episode dates; event extent not independently established.', verification })),
    eonet: Array.from({ length: 60 }, (_, i) => canonicalDiscoveryRecord({ id: `TEST_ONLY_EONET_${i}`, sourceId: 'eonet', source: 'NASA EONET', kind: 'curated-event',
      title: location, category: 'disasters', url: `https://eonet.gsfc.nasa.gov/api/v3/events/EONET_${1000 + i}`, sourceGeometryAt: stamp(-7200000),
      retrievedAt: stamp(), eonetCategories: [{ id: 'wildfires' }], referencedSources: Array.from({ length: 4 }, (_, j) => ({ id: `TEST_ONLY_SOURCE_${j}`,
        url: `https://reference${j}.test/attributable/original/report/with/a/descriptive/source/path/${i}?provider=source` })),
      timeMeaning: 'Curated source reference update; not an exact independently verified onset time.', verification })),
    gdelt: Array.from({ length: 240 }, (_, i) => canonicalDiscoveryRecord({ id: `TEST_ONLY_GKG_${i}`, sourceId: 'gdelt', source: 'GDELT', kind: 'topic-mention',
      category: 'geopolitics', categories: ['geopolitics', 'economy', 'disasters'], themes: ['ARMEDCONFLICT', 'WB_698_TRADE', 'EVACUATION', 'SANCTIONS'],
      url: `https://publisher${i % 12}.test/attributable/news/link/with/a/descriptive/source/path/${i}?provider=source`,
      mentionedCountries: ['BE', 'LV', 'US', 'GB', 'CN', 'RU'], batch: 'TEST_ONLY_20261011114500', aggregator: 'GDELT', indexedAt: stamp(-900000), retrievedAt: stamp(),
      timeMeaning: 'Source GKG batch index time; country mentions do not establish article publication or an incident location.', verification })),
  };
  assert.ok(Object.values(records).flat().every(Boolean));
  const all = Object.values(records).flat(), sourceBytes = new TextEncoder().encode(JSON.stringify(all)).byteLength;
  assert.ok(sourceBytes > 450000 && sourceBytes < 1200000, 'realistic substantial evidence payload, not tiny placeholder records');
  const captures = [];
  for (const [source, items] of Object.entries(records)) captures.push((await f.capture(0, items, source)).snapshots[0]);
  const accepted = { packet: { schemaVersion: 1, collectedAt: stamp(), payload: { indexRecords: all } }, snapshots: captures };
  const before = f.env.EARTH_DB.counters.statements; f.env.EARTH_DB.counters.maxBindings = 0;
  const result = await projectWorldCollection(f.env, accepted, { now: f.now }), statements = f.env.EARTH_DB.counters.statements - before;
  assert.equal(result.stored, true); assert.equal(result.revisionCount, 500); assert.equal(result.eventCount, 100); assert.equal(f.count('earth_world_captures'), 4);
  assert.ok(statements <= 25, `500 items/four sources used ${statements} D1 statements`);
  assert.equal(f.env.EARTH_DB.counters.maxBindings, 1); assert.ok(f.env.EARTH_DB.counters.maxJsonBytes > 200000);
  assert.ok(f.env.EARTH_DB.counters.maxJsonBytes <= 256 * 1024);
  t.diagnostic(JSON.stringify({ sourceBytes, publicationStatements: statements, maximumSqlJsonBytes: f.env.EARTH_DB.counters.maxJsonBytes }));
  f.setClock(61000); const repeated = [];
  for (const [source, items] of Object.entries(records)) repeated.push((await f.capture(60000, items, source)).snapshots[0]);
  const nextBefore = f.env.EARTH_DB.counters.statements;
  assert.equal((await projectWorldCollection(f.env, { packet: { ...accepted.packet, collectedAt: stamp(60000) }, snapshots: repeated }, { now: f.now })).revisionCount, 0);
  assert.equal(f.env.EARTH_DB.counters.statements - nextBefore, 4); assert.equal(f.count('earth_world_revisions'), 500); assert.equal(f.count('earth_world_observations'), 500);
});

test('publication windows bracket actual hosted knowledge without replacing source event/capture clocks', async (t) => {
  const f = await fixture(t); f.setClock(1000); await projectWorldCollection(f.env, await f.capture(0, [quake()]), { now: f.now });
  f.setClock(120000); await projectWorldCollection(f.env, await f.capture(60000, [quake(undefined, { magnitude: 5.7, updatedAt: stamp(59000) })]), { now: f.now });
  const gap = await readWorldEvents(f.env, { knownAt: stamp(500) }, { now: f.now });
  assert.equal(gap.publicationWindowStartAt, null); assert.equal(gap.nextPublicationAt, stamp(1000)); assert.equal(gap.publicationRevision, null);
  assert.equal(gap.currentPublishedRevision.capturedAt, stamp(60000));
  const before = await readWorldEvents(f.env, { knownAt: stamp(119999) }, { now: f.now });
  assert.equal(before.publicationWindowStartAt, stamp(1000)); assert.equal(before.nextPublicationAt, stamp(120000));
  assert.equal(before.publicationRevision.capturedAt, stamp()); assert.equal(before.events[0].eventTime.at, stamp(-300000));
  const at = await readWorldEvents(f.env, { knownAt: stamp(120000) }, { now: f.now });
  assert.equal(at.publicationWindowStartAt, stamp(120000)); assert.equal(at.nextPublicationAt, null);
  assert.equal(at.publicationRevision.capturedAt, stamp(60000)); assert.equal(at.events[0].reportedFacts.magnitude, 5.7);
});

test('historical range seek retains the exact allowed future-clock boundary and excludes later publication', async (t) => {
  const f = await fixture(t); f.setClock(5000); f.setDatabaseClock(0);
  assert.equal((await projectWorldCollection(f.env, await f.capture(305000, [quake()]), { now: f.now })).stored, true);
  f.setClock(60000); f.setDatabaseClock(60000);
  assert.equal((await projectWorldCollection(f.env, await f.capture(360000, [quake(undefined, { magnitude: 5.7, updatedAt: stamp(59000) })]), { now: f.now })).stored, true);
  const historical = await readWorldEvents(f.env, { knownAt: stamp() }, { now: f.now });
  assert.equal(historical.events[0].reportedFacts.magnitude, 5.1); assert.equal(historical.events[0].capture.capturedAt, stamp(305000));
  assert.equal(historical.publicationWindowStartAt, stamp()); assert.equal(historical.nextPublicationAt, stamp(60000));
  const plans = f.env.EARTH_DB.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT source_id, captured_at, snapshot_id, recorded_at FROM earth_world_captures
    WHERE source_id = ? AND captured_at <= ? AND recorded_at <= ? ORDER BY captured_at DESC LIMIT 1`).all('usgs', stamp(305000), stamp());
  assert.ok(plans.some((row) => /source_id=\? AND captured_at<\?/.test(row.detail)), 'historical lookup seeks the source/capture range');
  assert.ok(!plans.some((row) => /USE TEMP B-TREE/.test(row.detail)), 'ordered primary-key range requires no archive sort');
});

test('clock skew beyond the enforced publication bound retains evidence without a visible receipt', async (t) => {
  const f = await fixture(t); f.setClock(5001); f.setDatabaseClock(0);
  const accepted = await f.capture(305001, [quake()]);
  const result = await projectWorldCollection(f.env, accepted, { now: f.now });
  assert.equal(result.stored, false); assert.equal(f.count('earth_world_revisions'), 1); assert.equal(f.count('earth_world_captures'), 0);
  assert.ok(f.env.EARTH_STORE.records.has(`history/snapshots/usgs/${accepted.snapshots[0].id}.json`));
  assert.equal((await readWorldEvents(f.env, {}, { now: f.now })).events.length, 0);
  f.setDatabaseClock(1);
  assert.equal((await projectWorldCollection(f.env, accepted, { now: f.now })).stored, true);
  const current = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(current.events[0].knowledge.firstRecordedAt, stamp()); assert.equal(current.events[0].capture.publishedAt, stamp(1));
});

test('publication clock bound is evaluated during database execution after queued work', async (t) => {
  const f = await fixture(t); f.setClock(10000); f.setDatabaseClock(0); const accepted = await f.capture(310000, [quake()]);
  f.env.EARTH_DB.beforeBatch = (statements) => {
    if (statements.some((statement) => /INSERT INTO earth_world_captures/.test(statement.sql))) f.setDatabaseClock(5000);
  };
  assert.equal((await projectWorldCollection(f.env, accepted, { now: f.now })).stored, true);
  const before = await readWorldEvents(f.env, { knownAt: stamp(4999) }, { now: f.now }); assert.equal(before.events.length, 0);
  const at = await readWorldEvents(f.env, { knownAt: stamp(5000) }, { now: f.now });
  assert.equal(at.events[0].capture.publishedAt, stamp(5000)); assert.equal(at.events[0].capture.capturedAt, stamp(310000));
  assert.equal(at.events[0].eventTime.at, stamp(-300000));
});

test('retry restores the current watermark from its exact receipt and repaired receipts remain visible', async (t) => {
  const f = await fixture(t), accepted = await f.capture(0, [quake()]);
  assert.equal((await projectWorldCollection(f.env, accepted, { now: f.now })).stored, true);
  f.env.EARTH_DB.sqlite.prepare('DELETE FROM earth_world_sources WHERE source_id = ?').run('usgs');
  f.setClock(1000);
  const replay = await projectWorldCollection(f.env, accepted, { now: f.now });
  assert.equal(replay.stored, true); assert.equal(replay.revisionCount, 0);
  let scene = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(scene.events.length, 1); assert.equal(scene.events[0].capture.publishedAt, stamp());
  f.env.EARTH_DB.sqlite.prepare('DELETE FROM earth_world_captures WHERE source_id = ?').run('usgs');
  f.setClock(2000);
  assert.equal((await projectWorldCollection(f.env, accepted, { now: f.now })).stored, true);
  scene = await readWorldEvents(f.env, {}, { now: f.now });
  assert.equal(scene.events.length, 1); assert.equal(scene.events[0].capture.publishedAt, stamp(2000));
  assert.equal(scene.events[0].knowledge.firstRecordedAt, stamp());
  assert.equal(f.count('earth_world_revisions'), 1);
});
