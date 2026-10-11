import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { readsbSnapshot } from '../src/sources/live/aircraft.js';
import { AIRCRAFT_MAX_BYTES, AIRCRAFT_MAX_RECORDS, canonicalAircraftPacket,
  publishAircraftObservations, handleAircraftObservations } from './aircraft-observations.js';

const CLOCK = Date.parse('2026-10-11T12:00:00.000Z');
const SCOPE = { id: 'brussels-250km', type: 'area', latitude: 50.85, longitude: 4.35, radiusKm: 250 };
const iso = (at) => new Date(at).toISOString();
const clone = (value) => structuredClone(value);
const packet = (offset = 0, { fixAt = CLOCK + offset - 1000, sourceAt = CLOCK + offset,
  scope = SCOPE, unknown = false, rows = [{ hex: 'abc123', lat: 50.85, lon: 4.35 }], state = {} } = {}) => {
  const snapshot = readsbSnapshot({ ac: rows.map((row) => ({ flight: 'TEST', alt_baro: 30000,
    alt_geom: 30500, gs: 320, track: 180, geom_rate: 100, seen: 0.2,
    seen_pos: (sourceAt - fixAt) / 1000, category: 'A1', t: 'A320', r: 'OO-TEST', ownOp: 'Fixture',
    nic: 7, nac_p: 8, nac_v: 2, sil: 2, sil_type: 'persample', ...row })) },
  { observedAtMs: unknown ? null : sourceAt, observedAtSource: unknown ? 'unknown' : 'source', now: CLOCK + offset });
  return { schemaVersion: 1, source: 'adsb.lol', collectedAt: iso(CLOCK + offset), scope: clone(scope),
    observedAtMs: unknown ? null : sourceAt, observedAtSource: unknown ? 'unknown' : 'source',
    sourceState: { freshness: unknown ? 'unknown' : 'current', cache: 'MISS', cacheAgeMs: 0,
      ageMs: unknown ? null : Math.max(0, CLOCK + offset - sourceAt), complete: true, rejectedCount: 0, ...state },
    records: snapshot.records };
};

async function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql'])
    sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const binding = { sqlite, writes: 0, reads: 0, primary: 0,
    withSession(mode) { assert.equal(mode, 'first-primary'); this.primary++; return this; },
    prepare(sql) { return { bind(...args) { return {
      async run() { binding.writes++; if (binding.failWrites) throw new Error('private D1 error'); return sqlite.prepare(sql).run(...args); },
      async first() { binding.reads++; if (binding.failReads) throw new Error('private D1 error'); return sqlite.prepare(sql).get(...args) || null; },
    }; } }; },
  };
  return binding;
}
function storage(shared = { values: new Map(), serial: 0, writes: [] }) {
  const binding = { shared,
    async get(key) {
      await binding.onGet?.(key);
      if (binding.failGet?.(key)) throw new Error('private R2 error');
      const item = shared.values.get(key); if (!item) return null;
      return { etag: item.etag, size: Buffer.byteLength(item.text), body: new Response(item.text).body };
    },
    async put(key, text, options) {
      if (binding.failPut?.(key)) throw new Error('private R2 write error');
      const old = shared.values.get(key), condition = options?.onlyIf;
      const absent = condition instanceof Headers && condition.get('if-none-match') === '*';
      if (absent && old || condition?.etagMatches && condition.etagMatches !== old?.etag || binding.rejectCAS?.(key)) return null;
      const etag = String(++shared.serial); shared.values.set(key, { etag, text }); shared.writes.push({ key, text, etag });
      return { etag };
    },
  };
  return binding;
}
async function fixture(t) {
  const store = storage(), db = await database(t);
  return { store, db, env: { EARTH_STORE: store, EARTH_DB: db } };
}
const count = (db) => db.sqlite.prepare('SELECT COUNT(*) AS count FROM earth_aircraft_observations').get().count;
const request = (query = 'lat=50.85&lon=4.35&radiusKm=50', init) => new Request(`https://owned.example/api/aircraft/observations?${query}`, init);
const read = (env, at = CLOCK, query) => handleAircraftObservations(request(query), env, { now: () => at });
const publish = (env, input, at = Date.parse(input.collectedAt)) => publishAircraftObservations(env, input, { now: () => at });
const warm = (store, id = SCOPE.id) => JSON.parse(store.shared.values.get(`aircraft/prepared/${id}.json`).text);

test('generated actual SQLite capture index and immutable archive supply a prepared-only startup response', async (t) => {
  const { env, store, db } = await fixture(t), first = packet();
  const result = await publish(env, first);
  assert.equal(result.stored, true); assert.equal(result.indexed, true); assert.equal(result.changed, true);
  assert.equal(result.collectedAt, first.collectedAt); assert.equal(result.recordCount, 1);
  assert.deepEqual(JSON.parse(store.shared.values.get(`aircraft/captures/${result.snapshotId}.json`).text), canonicalAircraftPacket(first, { now: () => CLOCK }));
  const indexed = db.sqlite.prepare('SELECT * FROM earth_aircraft_observations').get();
  assert.equal(indexed.snapshot_id, result.snapshotId); assert.equal(indexed.observed_at_ms, first.observedAtMs);
  assert.equal(indexed.scope_json, JSON.stringify(SCOPE)); assert.equal(count(db), 1); assert.ok(db.primary);
  const upstream = globalThis.fetch; globalThis.fetch = () => { throw new Error('Prepared reads must never acquire'); };
  t.after(() => { globalThis.fetch = upstream; });
  const response = await read(env, CLOCK + 5000), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=5');
  assert.equal(response.headers.get('x-feed-age-ms'), '5000'); assert.equal(response.headers.get('x-feed-cache'), 'HIT');
  assert.equal(body.prepared, true); assert.equal(body.available, true); assert.equal(body.complete, false);
  assert.equal(body.sourceComplete, true); assert.equal(body.freshness, 'current');
  assert.equal(body.sourceAgeMs, 5000); assert.equal(body.captureAgeMs, 5000);
  assert.deepEqual(body.records, first.records); assert.deepEqual(body.history, []); assert.deepEqual(body.coverageScopes, [SCOPE]);
  assert.equal(db.reads, 1, 'public startup reads use R2, without DB or source fanout');
});

test('newer actual fixes retain at most two chronological earlier observations, with unchanged immutable captures', async (t) => {
  const { env, store, db } = await fixture(t), originals = [];
  for (const offset of [0, 20000, 40000, 60000]) {
    const input = packet(offset, { rows: [{ hex: 'abc123', lat: 50.85 + offset / 1000000, lon: 4.35 }] });
    const result = await publish(env, input); assert.equal(result.changed, true);
    originals.push([result.snapshotId, clone(canonicalAircraftPacket(input, { now: () => CLOCK + offset }))]);
  }
  const response = await read(env, CLOCK + 60000), body = await response.json();
  assert.deepEqual(body.history.map((row) => row.positionTimeMs), [CLOCK + 19000, CLOCK + 39000]);
  assert.equal(body.records[0].positionTimeMs, CLOCK + 59000); assert.equal(body.records[0].latitude, 50.85 + 60000 / 1000000);
  assert.equal(body.history.every((row) => row.positionTimeQuality === 'reported' && row.positionTimeMs < body.records[0].positionTimeMs), true);
  assert.equal(count(db), 4);
  for (const [id, original] of originals) assert.deepEqual(JSON.parse(store.shared.values.get(`aircraft/captures/${id}.json`).text), original);
});

test('duplicate retries and older/equal source snapshots preserve warm facts and capture date while recording real checks separately', async (t) => {
  const { env, store, db } = await fixture(t), first = packet(), initial = await publish(env, first);
  const writes = store.shared.writes.length;
  const duplicate = await publish(env, first); assert.equal(duplicate.changed, false); assert.equal(count(db), 1);
  assert.equal(store.shared.writes.length, writes); assert.equal(duplicate.inputDigest, initial.inputDigest);
  const equal = packet(10000, { sourceAt: CLOCK, fixAt: CLOCK - 1000, state: { cache: 'HIT', cacheAgeMs: 10000 } });
  const checked = await publish(env, equal); assert.equal(checked.changed, false); assert.equal(checked.superseded, true);
  assert.equal(checked.collectedAt, first.collectedAt); assert.equal(checked.lastCheckedAt, equal.collectedAt);
  const old = packet(20000, { sourceAt: CLOCK - 10000, fixAt: CLOCK - 11000,
    rows: [{ hex: 'abc123', lat: 51, lon: 4.6 }], state: { cache: 'STALE', freshness: 'stale', cacheAgeMs: 30000 } });
  const regressed = await publish(env, old); assert.equal(regressed.changed, false); assert.equal(regressed.collectedAt, first.collectedAt);
  assert.deepEqual(warm(store).records, first.records); assert.equal(warm(store).observedAtMs, CLOCK);
  const lateOlderCheck = await publish(env, packet(5000, { rows: [{ hex: 'abc123', lat: 52, lon: 4.7 }] }), CLOCK + 20000);
  assert.equal(lateOlderCheck.changed, false); assert.equal(lateOlderCheck.lastCheckedAt, old.collectedAt); assert.equal(count(db), 4);
  const body = await (await read(env, CLOCK + 20000)).json();
  assert.equal(body.freshness, 'stale'); assert.equal(body.collectedAt, first.collectedAt);
  assert.equal(body.captureAgeMs, 20000); assert.equal(body.lastCheckedAt, old.collectedAt);
});

test('a newer snapshot clock with identical exact fixes does not announce or redate unchanged warm facts', async (t) => {
  const { env, store } = await fixture(t), first = packet(), initial = await publish(env, first);
  const unchanged = packet(10000); unchanged.records = clone(first.records);
  const next = await publish(env, unchanged);
  assert.equal(next.changed, false); assert.equal(next.inputDigest, initial.inputDigest);
  assert.equal(next.collectedAt, first.collectedAt); assert.equal(next.lastCheckedAt, unchanged.collectedAt);
  assert.equal(warm(store).observedAtMs, CLOCK); assert.equal(next.superseded, true);
});

test('an expired actual fix cannot mutate or revive when a later snapshot reports the same or older per-identity fix', async (t) => {
  const { env, store } = await fixture(t), first = packet(), initial = await publish(env, first);
  for (const [offset, fixAt] of [[150000, CLOCK - 1000], [160000, CLOCK - 2000]]) {
    const repeated = packet(offset, { fixAt, rows: [{ hex: 'abc123', lat: 51.1, lon: 4.6 }] });
    const result = await publish(env, repeated);
    assert.equal(result.changed, false); assert.equal(result.inputDigest, initial.inputDigest); assert.equal(result.collectedAt, first.collectedAt);
    assert.deepEqual(warm(store).records, first.records);
  }
  const body = await (await read(env, CLOCK + 160000)).json();
  assert.equal(body.stale, true); assert.equal(body.records[0].positionTimeMs, CLOCK - 1000); assert.deepEqual(body.history, []);
  const genuinelyNew = await publish(env, packet(170000)); assert.equal(genuinelyNew.changed, true);
  assert.equal(warm(store).records[0].positionTimeMs, CLOCK + 169000); assert.deepEqual(warm(store).history, []);
});

test('source qualification and strict normalized fields reject fabricated time/model facts; unknown epochs remain static and unknown', async (t) => {
  const { env } = await fixture(t), unknown = packet(0, { unknown: true });
  assert.equal(unknown.records[0].positionTimeMs, null); assert.equal(unknown.records[0].contactTimeMs, null);
  assert.equal((await publish(env, unknown)).stored, true);
  const body = await (await read(env)).json();
  assert.equal(body.freshness, 'unknown'); assert.equal(body.observedAtMs, null); assert.equal(body.observedAtSource, 'unknown');
  assert.equal(body.records[0].latitude, 50.85); assert.deepEqual(body.history, []);
  const examples = [
    { ...packet(), records: [{ ...packet().records[0], predicted: true }] },
    { ...unknown, records: [{ ...unknown.records[0], positionTimeMs: CLOCK, positionTimeQuality: 'reported' }] },
    { ...packet(), records: [{ ...packet().records[0], positionTimeMs: CLOCK + 1 }] },
    { ...packet(), observedAtSource: 'receipt' },
    { ...packet(), observedAtMs: CLOCK + 5001 },
    { ...packet(), records: [{ ...packet().records[0], speedMps: '100' }] },
    { ...packet(), sourceState: { ...packet().sourceState, extra: true } },
    { ...packet(), records: [{ ...packet().records[0], category: { invented: true } }] },
    { ...packet(), records: [{ ...packet().records[0], courseDeg: 360 }] },
    { ...packet(), collectedAt: iso(CLOCK + 300001) },
  ];
  for (const value of examples) await assert.rejects(publish(env, value, CLOCK), TypeError);
});

test('coverage contains the whole requested disk and filters latest and historical fixes independently', async (t) => {
  const { env, store } = await fixture(t);
  const outsideLocal = packet(0, { rows: [{ hex: 'abc123', lat: 51.4, lon: 4.35 }, { hex: 'def456', lat: 50.85, lon: 4.35 },
    { hex: 'aaaaaa', lat: 55, lon: 4.35 }] });
  await publish(env, outsideLocal);
  await publish(env, packet(20000, { rows: [{ hex: 'abc123', lat: 50.85, lon: 4.35 }, { hex: 'def456', lat: 51.4, lon: 4.35 },
    { hex: 'aaaaaa', lat: 55, lon: 4.35 }] }));
  const body = await (await read(env, CLOCK + 20000, 'lat=50.85&lon=4.35&radiusKm=5')).json();
  assert.deepEqual(body.records.map((row) => row.id), ['abc123']); assert.deepEqual(body.history, []);
  assert.equal(warm(store).records.some((row) => row.id === 'aaaaaa'), false, 'padded upstream rows never broaden advertised warm coverage');
  const uncovered = await read(env, CLOCK + 20000, 'lat=52&lon=4.35&radiusKm=200');
  assert.equal(uncovered.status, 503); assert.equal((await uncovered.json()).code, 'not-covered');
  const military = await read(env, CLOCK + 20000, 'military=1'); assert.equal(military.status, 503);
  assert.deepEqual((await military.json()).coverageScopes, []);
  const militaryScope = { id: 'military-subset', type: 'military', latitude: null, longitude: null, radiusKm: null };
  await publish(env, packet(30000, { scope: militaryScope, rows: [{ hex: 'bbbbbb', lat: -50, lon: 130 }] }));
  const subset = await (await read(env, CLOCK + 30000, 'military=1')).json();
  assert.deepEqual(subset.coverageScopes, [militaryScope]); assert.equal(subset.complete, false); assert.match(subset.coverage, /completeness is not asserted/);
});

test('original stale dates are retained, current history expires, and unbounded age is unavailable', async (t) => {
  const { env } = await fixture(t), first = packet();
  await publish(env, first); await publish(env, packet(20000));
  let body = await (await read(env, CLOCK + 60000)).json();
  assert.equal(body.stale, false); assert.equal(body.collectedAt, iso(CLOCK + 20000)); assert.equal(body.history.length, 1);
  body = await (await read(env, CLOCK + 150000)).json();
  assert.equal(body.stale, true); assert.equal(body.freshness, 'stale'); assert.deepEqual(body.history, []);
  assert.equal(body.records[0].positionTimeMs, CLOCK + 19000); assert.equal(body.captureAgeMs, 130000);
  assert.equal(body.sourceAgeMs, 130000); assert.equal(body.collectedAt, iso(CLOCK + 20000));
  assert.equal((await read(env, CLOCK + 86420000)).status, 200);
  const expired = await read(env, CLOCK + 86420001); assert.equal(expired.status, 503); assert.equal((await expired.json()).code, 'unavailable');
});

test('D1 conflicts and R2/database/CAS failures preserve the prior prepared generation and support exact retries', async (t) => {
  const { env, store, db } = await fixture(t), first = packet();
  const original = await publish(env, first);
  const sameClockDifferentFacts = packet(0, { rows: [{ hex: 'abc123', lat: 51, lon: 4.35 }] });
  const conflict = await publish(env, sameClockDifferentFacts); assert.equal(conflict.conflict, true); assert.equal(conflict.stored, false);
  assert.equal(warm(store).inputDigest, original.inputDigest); assert.equal(count(db), 1);
  const later = packet(20000), saved = clone(warm(store));
  store.failPut = key => key.startsWith('aircraft/captures/');
  assert.equal((await publish(env, later)).stored, false); assert.deepEqual(warm(store), saved); assert.equal(count(db), 1);
  delete store.failPut; db.failWrites = true;
  assert.equal((await publish(env, later)).stored, false); assert.deepEqual(warm(store), saved); assert.equal(count(db), 1);
  db.failWrites = false; store.rejectCAS = key => key.startsWith('aircraft/prepared/');
  const partial = await publish(env, later); assert.equal(partial.stored, false); assert.equal(partial.changed, false);
  assert.deepEqual(warm(store), saved); assert.equal(count(db), 2); assert.equal(JSON.stringify(partial).includes('private'), false);
  delete store.rejectCAS;
  const retry = await publish(env, later); assert.equal(retry.stored, true); assert.equal(retry.changed, true); assert.equal(count(db), 2);
  const duplicate = await publish(env, later); assert.equal(duplicate.changed, false); assert.equal(duplicate.inputDigest, retry.inputDigest);
});

test('an uncommitted reserved scope never advertises collected coverage and strict route failures remain no-store', async (t) => {
  const { env, store } = await fixture(t); store.failPut = key => key.startsWith('aircraft/captures/');
  assert.equal((await publish(env, packet())).stored, false);
  const unprepared = await read(env); assert.equal(unprepared.status, 503); assert.deepEqual((await unprepared.json()).coverageScopes, []);
  const notConfigured = await read({}); assert.equal(notConfigured.status, 503); assert.equal(notConfigured.headers.get('cache-control'), 'no-store');
  assert.equal((await notConfigured.json()).code, 'not-configured');
  for (const query of ['', 'lat=50&lon=4&radiusKm=0', 'lat=50&lon=4&radiusKm=251', 'lat=50&lon=4&radiusKm=20&lat=51',
    'lat=50&lon=4&radiusKm=20&extra=1', 'military=0', 'military=1&lat=50']) assert.equal((await read(env, CLOCK, query)).status, 400);
  assert.equal((await handleAircraftObservations(request('military=1', { method: 'POST' }), env)).status, 405);
  assert.equal(await handleAircraftObservations(new Request('https://owned.example/other'), env), null);
});

test('independent isolate storage handles CAS races without regressing the durable warm generation', async (t) => {
  const { env, store, db } = await fixture(t); await publish(env, packet());
  const secondStore = storage(store.shared), secondEnv = { EARTH_STORE: secondStore, EARTH_DB: db };
  let readers = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const onGet = async key => { if (key === `aircraft/prepared/${SCOPE.id}.json` && readers < 2) { readers++; if (readers === 2) release(); await barrier; } };
  store.onGet = onGet; secondStore.onGet = onGet;
  const [older, newer] = await Promise.all([publish(env, packet(10000), CLOCK + 20000), publish(secondEnv, packet(20000))]);
  assert.equal(older.stored, true); assert.equal(newer.stored, true); assert.equal(count(db), 3);
  assert.equal(warm(store).collectedAt, iso(CLOCK + 20000)); assert.equal(warm(store).records[0].positionTimeMs, CLOCK + 19000);
  assert.equal(newer.recordCount, 1); assert.equal(newer.inputDigest, warm(store).inputDigest);
});

test('record, scope and response byte limits retain bounded exact history rather than silently clipping immutable captures', async (t) => {
  const { env, store, db } = await fixture(t);
  const tooMany = packet(); tooMany.records = Array.from({ length: AIRCRAFT_MAX_RECORDS + 1 }, () => tooMany.records[0]);
  await assert.rejects(publish(env, tooMany), TypeError);
  for (let index = 0; index < 8; index++) assert.equal((await publish(env, packet(0, { scope: { ...SCOPE, id: `scope-${index}` } }))).stored, true);
  await assert.rejects(publish(env, packet(0, { scope: { ...SCOPE, id: 'scope-8' } })), TypeError);
  await assert.rejects(publish(env, packet(1000, { scope: { ...SCOPE, id: 'scope-0', radiusKm: 100 } })), TypeError);
  const largeStore = storage(), largeEnv = { EARTH_STORE: largeStore, EARTH_DB: db };
  const rows = Array.from({ length: 2000 }, (_, index) => ({ hex: (index + 1).toString(16).padStart(6, '0'), lat: 50.85, lon: 4.35,
    ownOp: 'O'.repeat(110), flight: 'F'.repeat(32), r: 'R'.repeat(40), t: 'T'.repeat(24) }));
  for (const offset of [0, 20000, 40000]) {
    const input = packet(offset, { rows, scope: { ...SCOPE, id: 'large' } });
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < AIRCRAFT_MAX_BYTES);
    const result = await publish(largeEnv, input); assert.equal(result.stored, true);
    assert.equal(JSON.parse(largeStore.shared.values.get(`aircraft/captures/${result.snapshotId}.json`).text).records.length, 2000);
  }
  const response = await read(largeEnv, CLOCK + 40000), text = await response.text(), body = JSON.parse(text);
  assert.equal(response.status, 200); assert.ok(Buffer.byteLength(text) <= AIRCRAFT_MAX_BYTES);
  assert.equal(body.records.length, 2000); assert.ok(body.history.length < 4000); assert.ok(body.omittedHistoryCount > 0);
  const counts = new Map(); for (const row of body.history) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  assert.equal([...counts.values()].every(value => value <= 2), true);
  assert.equal(store.shared.values.has('aircraft/prepared/scope-8.json'), false);
});
