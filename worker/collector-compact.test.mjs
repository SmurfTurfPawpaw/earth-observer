import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import * as collector from './collector.js';
import { createGdeltSnapshotReader, GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';
import { normalizeGdelt } from '../server/hosted/intelligence-sources.js';
import { createGkgSnapshot, gkgTopicReport, validateGkgSnapshot } from '../server/hosted/gdelt-gkg.js';
import { COLLECTION_OPERATIONAL_SOURCE_MAX_BYTES } from './collection-check.js';
import { gdeltQueryUrl } from '../server/hosted/gdelt-query.js';
import { collectionFactsDigest } from '../src/core/collection-facts.js';
import { publishCollectionRevision } from './collection-updates.js';
import { handleCollection } from './collection-api.js';
import { readWorldEvents } from './world-model.js';
import { readPreparedIntelligence, createHistoryHandler, PREPARED_INTELLIGENCE_KEY, PreparedBaselineConflict } from './history.js';

const CLOCK = Date.parse('2026-10-11T22:00:00.000Z'), MINUTE = 60_000;
const stamp = offset => new Date(CLOCK + offset).toISOString();
const clone = value => structuredClone(value);
const captures = f => ['earth_observations', 'earth_world_captures', 'earth_world_revisions', 'earth_collection_revision']
  .map(table => [table, f.count(table)]);
const persistenceKey = key => !key.startsWith('providers/');

function quake(revision = 0) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'us7000compactfixture',
    geometry: { type: 'Point', coordinates: [4.35, 50.85, 12] }, properties: {
      type: 'earthquake', title: 'TEST ONLY compact collection earthquake', mag: 5.2 + revision,
      status: 'reviewed', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000compactfixture',
      time: CLOCK - 5 * MINUTE, updated: CLOCK - MINUTE + revision * MINUTE } }] };
}
function gdacs() {
  return { features: [{ geometry: { type: 'Point', coordinates: [4.4, 50.8] }, properties: {
    eventid: 42, episodeid: 1, eventtype: 'FL', name: 'TEST ONLY compact collection flood',
    url: { report: 'https://www.gdacs.org/report.aspx?eventid=42&eventtype=FL' },
    fromdate: stamp(-3_600_000), datemodified: stamp(-MINUTE), alertlevel: 'Green', affectedcountries: [{ iso2: 'BE' }] } }] };
}
function eonet() {
  return { events: [{ id: 'EONET_123456', title: 'TEST ONLY compact collection wildfire',
    categories: [{ id: 'wildfires' }], sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/incident/compact-fixture' }],
    closed: null, geometry: [{ date: stamp(-7_200_000), type: 'Point', coordinates: [4, 50] }] }] };
}
function gdelt(generatedAt = stamp(0)) {
  const retrievedAt = stamp(0), categories = Object.fromEntries(['geopolitics', 'economy', 'disasters'].map(category => [category, {
    queryUrl: gdeltQueryUrl({ category }), retrievedAt,
    reports: normalizeGdelt({ articles: [{ title: `TEST ONLY compact ${category} metadata`,
      url: `https://publisher.example/compact/${category}`, seendate: stamp(-MINUTE),
      sourcecountry: 'Belgium', language: 'English' }] }, retrievedAt, category),
  }]));
  return { schemaVersion: 1, generatedAt, source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: Object.keys(categories) }, categories };
}

async function fixture(t) {
  let clock = CLOCK, serial = 0, sequence = Promise.resolve(), sqlInterceptor;
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    return new Date(clock + (modifier ? Number(modifier.split(' ')[0]) * 1000 : 0)).toISOString();
  });
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
    sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
  const objects = new Map(), activity = { sql: [], r2: [], fetches: [] };
  const store = {
    async get(key) {
      activity.r2.push({ operation: 'get', key }); const row = objects.get(key);
      return row ? { etag: row.etag, size: Buffer.byteLength(row.body),
        json: async () => JSON.parse(row.body), text: async () => row.body } : null;
    },
    async head(key) { activity.r2.push({ operation: 'head', key }); const row = objects.get(key);
      return row ? { etag: row.etag, size: Buffer.byteLength(row.body) } : null; },
    async put(key, body, options = {}) {
      const previous = objects.get(key), text = String(body);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous ||
          options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) {
        activity.r2.push({ operation: 'conflict', key }); return null;
      }
      const row = { body: text, etag: String(++serial) }; objects.set(key, row);
      activity.r2.push({ operation: 'put', key, bytes: Buffer.byteLength(text) }); return row;
    },
  };
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(sql) {
      const bind = (...values) => {
        const execute = async mode => {
          const write = /^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql);
          activity.sql.push({ sql, write, mode });
          if (sqlInterceptor) {
            const intercepted = await sqlInterceptor({ sql, values, mode });
            if (intercepted !== undefined) return intercepted;
          }
          const statement = sqlite.prepare(sql);
          if (mode === 'first') return statement.get(...values) || null;
          if (mode === 'all') return { success: true, results: statement.all(...values), meta: { changes: 0 } };
          return { success: true, results: [], meta: { changes: Number(statement.run(...values).changes) } };
        };
        return { sql, values, first: () => execute('first'), all: () => execute('all'), run: () => execute('run') };
      };
      return { ...bind(), bind };
    },
    batch(statements) {
      const operation = sequence.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements)
            results.push(/^\s*SELECT/i.test(statement.sql) || /RETURNING \*/.test(statement.sql) ? await statement.all() : await statement.run());
          sqlite.exec('COMMIT'); return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      sequence = operation.catch(() => {}); return operation;
    },
  };
  const env = { EARTH_DB: db, EARTH_STORE: store }, now = () => clock;
  let inputs = { revision: 0, gdeltGeneration: stamp(0), usgsUnavailable: false };
  const fetchImpl = async (input, options = {}) => {
    const url = String(input); activity.fetches.push(url);
    assert.ok((url === GDELT_SNAPSHOT_URL ? ['follow'] : ['error', 'manual']).includes(options.redirect),
      'Only the fixed owned release permits redirects; official source adapters refuse them');
    if (url === GDELT_SNAPSHOT_URL) return Response.json(gdelt(inputs.gdeltGeneration), { headers: { etag: '"compact-fixture"' } });
    if (url === EONET_QUERY_URL) return Response.json(eonet());
    if (url === 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson')
      return inputs.usgsUnavailable ? new Response('', { status: 503 }) : Response.json(quake(inputs.revision));
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://www.gdacs.org'); assert.equal(parsed.pathname, '/gdacsapi/api/events/geteventlist/SEARCH');
    assert.equal(parsed.searchParams.get('eventlist'), 'EQ;TC;FL;VO;WF;DR');
    return Response.json(gdacs());
  };
  const snapshotReader = createGdeltSnapshotReader({ fetchImpl, now });
  return { env, now, sqlite, objects, store, activity, fetchImpl, snapshotReader,
    clock(offset) { clock = CLOCK + offset; },
    inputs(next) { inputs = { ...inputs, ...next }; },
    intercept(next) { sqlInterceptor = next; },
    count(table) { return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); },
    reset() { activity.sql.length = 0; activity.r2.length = 0; activity.fetches.length = 0; },
    async packet(offset = 0, changes = {}) {
      const packetNow = () => CLOCK + offset;
      const reader = createGdeltSnapshotReader({ fetchImpl: async () => Response.json(gdelt(changes.gdeltGeneration || stamp(0))), now: packetNow });
      const sourceFetch = async input => {
        const url = String(input);
        if (url === EONET_QUERY_URL) return Response.json(eonet());
        if (url.includes('earthquake.usgs.gov')) return Response.json(quake(changes.revision || 0));
        assert.ok(url.startsWith('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH'));
        return Response.json(gdacs());
      };
      const result = await collector.collectEarthSources({}, {}, { now: packetNow, fetchImpl: sourceFetch, snapshotReader: reader });
      assert.equal(result.configured, false); assert.ok(result.packet);
      return result.packet;
    },
    async persist(packet, overrideEnv = env) {
      assert.equal(typeof collector.persistHostedCollection, 'function', 'Hosted selector must be available');
      return collector.persistHostedCollection(overrideEnv, packet, { now });
    },
    async announce(result) {
      assert.equal(result.prepared?.promoted, true); assert.equal(result.world?.stored, true);
      return publishCollectionRevision(env, { collectedAt: result.prepared.collectedAt,
        inputDigest: result.prepared.inputDigest, recordCount: result.prepared.recordCount });
    },
  };
}

function assertCompact(result, checkedAt, digest, count = 6) {
  assert.equal(result.stored, true); assert.equal(result.heartbeat, true); assert.equal(result.factualPublication, false);
  assert.equal(result.collectedAt, stamp(0)); assert.equal(result.checkedAt, checkedAt);
  assert.equal(result.inputDigest, digest); assert.equal(result.recordCount, count);
  assert.deepEqual(result.snapshots, []); assert.deepEqual(result.failures, []);
  assert.notEqual(result.prepared?.promoted, true); assert.notEqual(result.world?.stored, true);
}

test('actual hosted adapters compact a completed unchanged capture with one proof read and one operational pointer write', async t => {
  const f = await fixture(t);
  const first = await collector.collectEarthSources(f.env, {}, { now: f.now, fetchImpl: f.fetchImpl, snapshotReader: f.snapshotReader });
  assert.equal(first.snapshots.length, 4, JSON.stringify(first)); await f.announce(first);
  assert.equal(f.activity.fetches.length, 4); const before = captures(f), digest = first.prepared.inputDigest;
  const original = clone((await readPreparedIntelligence(f.env, { now: f.now })).payload.indexRecords);
  f.clock(61_000); f.reset();
  const next = await collector.collectEarthSources(f.env, {}, { now: f.now, fetchImpl: f.fetchImpl, snapshotReader: f.snapshotReader });
  assertCompact(next, stamp(61_000), digest);
  assert.deepEqual(captures(f), before); assert.equal(f.activity.sql.filter(row => row.write).length, 0);
  assert.equal(f.activity.sql.length, 1, 'One grouped primary completion read');
  const r2 = f.activity.r2.filter(row => persistenceKey(row.key));
  assert.equal(r2.filter(row => row.operation === 'get').length, 2);
  assert.deepEqual(r2.filter(row => row.operation === 'put').map(row => row.key), [PREPARED_INTELLIGENCE_KEY]);
  const prepared = await readPreparedIntelligence(f.env, { now: f.now });
  assert.deepEqual(prepared.payload.indexRecords, original, 'Operational acquisition cannot retime retained source records');
  assert.equal(prepared.payload.sources.find(source => source.id === 'usgs').retrievedAt, stamp(0));
  assert.equal(prepared.payload.sources.find(source => source.id === 'usgs').lastSuccessfulCheckAt, stamp(61_000));
  const history = await (await createHistoryHandler({ env: f.env, now: f.now })(
    new Request(`https://owned.example/api/history?at=${encodeURIComponent(stamp(61_000))}`))).json();
  assert.equal(history.lastAt, stamp(0)); assert.ok(history.reports.every(record => record.retrievedAt === stamp(0)));
});

test('a valid maximum 96-batch GDELT integrity ledger takes bounded full publication when source metadata exceeds compact bytes', async t => {
  const f = await fixture(t);
  const processedBatches = Array.from({ length: 96 }, (_, index) => {
    const at = CLOCK - (95 - index) * 900000;
    return { id: new Date(at).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14), retrievedAt: new Date(at).toISOString(), rows: 1, matchedRecords: 1,
      integrity: { mode: 'https-head-size-and-zip-crc', sha256: 'a'.repeat(64), archiveBytes: 1000, expandedBytes: 2000,
        providerMd5: null, providerEtag: `"${'e'.repeat(120)}"` } };
  });
  const latest = processedBatches.at(-1), themes = { geopolitics: 'ARMEDCONFLICT', economy: 'WB_698_TRADE', disasters: 'NATURAL_DISASTER' };
  const snapshot = validateGkgSnapshot(createGkgSnapshot({ generatedAt: stamp(0), processedBatches,
    reports: Object.entries(themes).map(([category, theme]) => gkgTopicReport({ category, themes: [theme], mentionedCountries: ['BE'],
      batch: latest.id, retrievedAt: latest.retrievedAt, url: `https://publisher.example/TEST-ONLY-ledger/${category}` })) }), CLOCK);
  assert.equal(snapshot.coverage.processedBatches.length, 96);
  const acquire = async () => {
    const fetchImpl = (url, options) => String(url) === GDELT_SNAPSHOT_URL ? Promise.resolve(Response.json(snapshot)) : f.fetchImpl(url, options);
    const reader = createGdeltSnapshotReader({ now: f.now, fetchImpl });
    return (await collector.collectEarthSources({}, {}, { now: f.now, fetchImpl, snapshotReader: reader })).packet;
  };
  const initial = await acquire(); assert.ok(initial);
  assert.ok(Buffer.byteLength(JSON.stringify(initial.payload.sources)) > COLLECTION_OPERATIONAL_SOURCE_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 1_200_000);
  const first = await f.persist(initial); await f.announce(first); const before = captures(f);
  f.clock(61_000); const next = await acquire();
  assert.equal(next.payload.sources.find(source => source.id === 'gdelt').processedBatches.length, 96);
  assert.equal(await collectionFactsDigest(next.payload.indexRecords), first.prepared.inputDigest);
  const result = await f.persist(next);
  assert.equal(result.stored, true); assert.notEqual(result.heartbeat, true); assert.equal(result.prepared.promoted, true);
  assert.equal(result.collectedAt, stamp(61_000)); assert.equal(f.count('earth_observations'), 8); assert.equal(f.count('earth_world_captures'), 8);
  assert.equal(f.count('earth_world_revisions'), before.find(([table]) => table === 'earth_world_revisions')[1]);
});

test('missing notification is repaired at the original capture before a compact check without new history or world captures', async t => {
  const f = await fixture(t), packet = await f.packet(), first = await f.persist(packet);
  assert.equal(first.prepared.promoted, true); assert.equal(f.count('earth_collection_revision'), 0);
  const before = captures(f).filter(([table]) => table !== 'earth_collection_revision');
  f.clock(61_000); f.reset(); const next = await f.persist(await f.packet(61_000));
  assertCompact(next, stamp(61_000), first.prepared.inputDigest);
  const revision = f.sqlite.prepare('SELECT * FROM earth_collection_revision WHERE id=1').get();
  assert.equal(revision.collected_at, stamp(0)); assert.equal(revision.input_digest, first.prepared.inputDigest);
  assert.equal(revision.record_count, packet.payload.indexRecords.length);
  assert.deepEqual(captures(f).filter(([table]) => table !== 'earth_collection_revision'), before);
  assert.ok(f.activity.r2.every(row => !row.key.startsWith('history/')), 'Notification-only repair must avoid source history writes');
});

test('a missing world receipt repairs its original source capture and leaves later check time operational', async t => {
  const f = await fixture(t), first = await f.persist(await f.packet()); await f.announce(first);
  f.sqlite.prepare('DELETE FROM earth_world_captures WHERE source_id=? AND captured_at=?').run('usgs', stamp(0));
  const observations = f.count('earth_observations'), revisions = f.count('earth_world_revisions');
  f.clock(61_000); const next = await f.persist(await f.packet(61_000));
  assertCompact(next, stamp(61_000), first.prepared.inputDigest);
  assert.equal(f.count('earth_world_captures'), 4); assert.equal(f.count('earth_observations'), observations);
  assert.equal(f.count('earth_world_revisions'), revisions);
  const restored = f.sqlite.prepare('SELECT captured_at FROM earth_world_captures WHERE source_id=?').get('usgs');
  assert.equal(restored.captured_at, stamp(0));
  assert.equal(f.sqlite.prepare('SELECT MAX(at) AS at FROM earth_observations').get().at, stamp(0));
  assert.equal(f.sqlite.prepare('SELECT collected_at FROM earth_collection_revision WHERE id=1').get().collected_at, stamp(0));
  const world = await readWorldEvents(f.env, { limit: 100 }, { now: f.now });
  assert.equal(world.available, true); assert.equal(world.events.length, 1, 'Repaired source receipt must remain readable through its matching publication watermark');
});

test('equal-date conflicting notification is explicit and cannot manufacture a newer capture', async t => {
  const f = await fixture(t), first = await f.persist(await f.packet()); await f.announce(first);
  f.sqlite.prepare('UPDATE earth_collection_revision SET input_digest=?,revision=? WHERE id=1')
    .run('f'.repeat(64), `${stamp(0)}:${'f'.repeat(64)}`);
  const before = captures(f), original = f.objects.get(PREPARED_INTELLIGENCE_KEY).body;
  f.clock(61_000); f.reset();
  let outcome, error;
  try { outcome = await f.persist(await f.packet(61_000)); } catch (caught) { error = caught; }
  assert.ok(error instanceof PreparedBaselineConflict || outcome?.conflict || outcome?.stored === false,
    'A conflicting retained revision must be a conflict or explicit partial outcome');
  assert.deepEqual(captures(f), before); assert.equal(f.objects.get(PREPARED_INTELLIGENCE_KEY).body, original);
  assert.equal(f.activity.sql.filter(row => row.write).length, 0);
});

test('unavailable, invalid or unresolved primary completion proof never falls through into a new factual capture', async t => {
  for (const kind of ['unavailable', 'invalid', 'timeout']) await t.test(kind, async sub => {
    const f = await fixture(sub), first = await f.persist(await f.packet()); await f.announce(first);
    const before = captures(f), original = f.objects.get(PREPARED_INTELLIGENCE_KEY).body;
    f.clock(61_000); f.reset(); let intercepted = 0;
    f.intercept(({ sql, mode }) => {
      if (/earth_world_captures/.test(sql) && /earth_observations/.test(sql) && !/^\s*(?:INSERT|UPDATE)/i.test(sql)) {
        intercepted++; if (kind === 'unavailable') throw Error('TEST ONLY primary completion deadline exceeded');
        if (kind === 'timeout') return new Promise(() => {});
        return mode === 'first' ? { invalid: true } : { success: true, results: null };
      }
    });
    let outcome, error;
    try { outcome = await f.persist(await f.packet(61_000)); } catch (caught) { error = caught; }
    assert.ok(intercepted > 0, 'The real grouped completion proof was injected');
    assert.ok(error || outcome?.stored === false || outcome?.conflict);
    assert.deepEqual(captures(f), before); assert.equal(f.objects.get(PREPARED_INTELLIGENCE_KEY).body, original);
    assert.equal(f.activity.sql.filter(row => row.write).length, 0);
  });
});

test('actual compact collector route repairs research admission after a lost background wake without republishing facts', async t => {
  const f = await fixture(t); f.env.EARTH_COLLECTOR_TOKEN = 't'.repeat(64);
  const post = () => new Request('https://owned.example/api/collector', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${f.env.EARTH_COLLECTOR_TOKEN}` }, body: '{"action":"collect"}' });
  const fetchImpl = async (input, options) => /\/feed\/v1\.0\/detail\/us7000compactfixture\.geojson$/.test(String(input))
    ? Response.json(quake().features[0]) : f.fetchImpl(input, options);
  const first = await handleCollection(post(), f.env, {}, { now: f.now, fetchImpl });
  assert.equal(first.status, 200); const initial = await first.json(); assert.equal(initial.updatesPublished, true);
  assert.equal(initial.research.scheduled, false); assert.equal(f.count('earth_investigation_jobs'), 0);
  const before = captures(f); f.clock(61_000); const tasks = [];
  const response = await handleCollection(post(), f.env, { waitUntil(task) { tasks.push(task); } }, { now: f.now, fetchImpl });
  assert.equal(response.status, 200); const compact = await response.json();
  assertCompact(compact, stamp(61_000), initial.prepared.inputDigest); assert.equal(compact.updatesPublished, false);
  assert.equal(compact.research.scheduled, true); assert.equal(tasks.length, 1); assert.deepEqual(captures(f), before);
  const research = await tasks[0]; assert.equal(research.mode, 'due-only'); assert.equal(research.admissionRepaired, true);
  assert.equal(research.jobAccepted, true); assert.equal(research.jobState, 'succeeded'); assert.equal(f.count('earth_investigation_jobs'), 1);
  f.clock(122_000); const idleTasks = [];
  const idle = await handleCollection(post(), f.env, { waitUntil(task) { idleTasks.push(task); } }, { now: f.now, fetchImpl });
  assert.equal(idle.status, 200); const advanced = await idleTasks[0];
  assert.equal(advanced.admissionRepaired, false); assert.equal(advanced.enqueueCount, 0); assert.equal(advanced.jobStarted, false);
  assert.deepEqual(captures(f), before); assert.equal(f.count('earth_investigation_jobs'), 1);
});

test('corrections, membership withdrawal, GDELT generation and EONET mode changes retain the full publication path', async t => {
  const cases = {
    correction: async f => f.packet(61_000, { revision: 1 }),
    withdrawal: async f => {
      const packet = await f.packet(61_000);
      packet.payload.indexRecords = packet.payload.indexRecords.filter(record => record.sourceId !== 'usgs');
      const scope = packet.payload.indexCoverage.sources.find(source => source.id === 'usgs'); scope.recordCount = 0;
      packet.payload.indexCoverage.recordCount = packet.payload.indexRecords.length;
      return packet;
    },
    'GDELT coverage only': async f => f.packet(61_000, { gdeltGeneration: stamp(61_000) }),
    'EONET fallback mode': async f => {
      const packet = await f.packet(61_000), source = packet.payload.sources.find(source => source.id === 'eonet');
      source.mode = 'scheduled-eonet-fallback'; source.status = 'stale'; source.stale = true;
      packet.payload.indexCoverage.sources.find(source => source.id === 'eonet').status = 'stale';
      return packet;
    },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async sub => {
    const f = await fixture(sub), initial = await f.packet(), first = await f.persist(initial); await f.announce(first);
    f.clock(61_000); const changed = await change(f);
    if (name.includes('GDELT') || name.includes('EONET'))
      assert.equal(await collectionFactsDigest(changed.payload.indexRecords), first.prepared.inputDigest, 'This change affects provenance, not selected facts');
    const result = await f.persist(changed);
    assert.equal(result.stored, true); assert.notEqual(result.heartbeat, true);
    assert.equal(result.prepared.promoted, true); assert.equal(result.world.stored, true);
    assert.equal(result.collectedAt, stamp(61_000)); assert.equal(f.count('earth_observations'), 8);
    assert.equal(f.count('earth_world_captures'), 8);
    const prepared = await readPreparedIntelligence(f.env, { now: f.now });
    assert.equal(prepared.collectedAt, stamp(61_000));
    if (name === 'correction') assert.equal(prepared.payload.indexRecords.find(record => record.sourceId === 'usgs').magnitude, 6.2);
    if (name === 'withdrawal') assert.equal(prepared.payload.indexRecords.some(record => record.sourceId === 'usgs'), false);
    if (name.includes('GDELT')) assert.equal(prepared.payload.sources.find(source => source.id === 'gdelt').generatedAt, stamp(61_000));
    if (name.includes('EONET')) assert.equal(prepared.payload.sources.find(source => source.id === 'eonet').mode, 'scheduled-eonet-fallback');
  });
});

test('provider failure with retained identical evidence is operational and cannot renew factual or successful retrieval dates', async t => {
  const f = await fixture(t), first = await f.persist(await f.packet()); await f.announce(first);
  const before = captures(f); f.clock(61_000); const packet = await f.packet(61_000);
  const source = packet.payload.sources.find(source => source.id === 'usgs');
  source.status = 'stale'; source.stale = true; source.retrievedAt = stamp(0);
  source.lastAttemptAt = stamp(61_000); source.reason = 'TEST ONLY provider HTTP 503'; source.retryAt = CLOCK + 121_000;
  packet.payload.indexCoverage.sources.find(scope => scope.id === 'usgs').status = 'stale';
  const result = await f.persist(packet); assertCompact(result, stamp(61_000), first.prepared.inputDigest);
  const prepared = await readPreparedIntelligence(f.env, { now: f.now }), retained = prepared.payload.sources.find(item => item.id === 'usgs');
  assert.equal(retained.status, 'stale'); assert.equal(retained.retrievedAt, stamp(0)); assert.equal(retained.lastAttemptAt, stamp(61_000));
  assert.notEqual(retained.lastSuccessfulCheckAt, stamp(61_000)); assert.deepEqual(captures(f), before);
  assert.equal(prepared.payload.indexRecords.find(record => record.sourceId === 'usgs').retrievedAt, stamp(0));
});

test('CAS retry rejects a newer same-facts coverage promotion and cannot overwrite its prepared pointer or world capture', async t => {
  const f = await fixture(t), first = await f.persist(await f.packet()); await f.announce(first);
  const unchanged = await f.packet(61_000), newer = await f.packet(62_000, { gdeltGeneration: stamp(62_000) });
  assert.equal(await collectionFactsDigest(newer.payload.indexRecords), first.prepared.inputDigest);
  let release, arrived, heldOnce = false;
  const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { arrived = resolve; });
  const compactStore = {
    get: f.store.get.bind(f.store), head: f.store.head.bind(f.store),
    async put(key, body, options) {
      if (key === PREPARED_INTELLIGENCE_KEY && JSON.parse(String(body)).checkedAt && !heldOnce) {
        heldOnce = true; arrived(); await held;
      }
      return f.store.put(key, body, options);
    },
  };
  f.clock(61_000);
  const compact = f.persist(unchanged, { ...f.env, EARTH_STORE: compactStore });
  const settled = compact.then(value => ({ value }), error => ({ error }));
  let timer;
  try {
    await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Compact pointer CAS was never reached')), 2000); })]);
    f.clock(62_000); const published = await collector.persistEarthCollection(f.env, newer, { now: f.now });
    await f.announce(published); const prepared = f.objects.get(PREPARED_INTELLIGENCE_KEY).body;
    release(); const outcome = await settled;
    assert.ok(outcome.error instanceof PreparedBaselineConflict || outcome.value?.conflict || outcome.value?.stored === false);
    assert.equal(f.objects.get(PREPARED_INTELLIGENCE_KEY).body, prepared);
    const current = await readPreparedIntelligence(f.env, { now: f.now });
    assert.equal(current.collectedAt, stamp(62_000)); assert.equal(current.payload.sources.find(source => source.id === 'gdelt').generatedAt, stamp(62_000));
    assert.equal(f.sqlite.prepare('SELECT MAX(captured_at) AS at FROM earth_world_captures').get().at, stamp(62_000));
    assert.equal(f.count('earth_world_captures'), 8);
  } finally { clearTimeout(timer); release(); await settled; }
});
