import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createEarthRuntime } from './index.js';
import { collectEarthSources } from './collector.js';
import { collectionFactsDigest } from './collection-publication.js';
import { factsDigest } from '../scripts/local-intelligence-pipeline.mjs';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { readsbSnapshot } from '../src/sources/live/aircraft.js';

function bucket() {
  const records = new Map(); let serial = 0;
  return {
    async get(key) { const value = records.get(key); return value ? { etag: value.etag, size: value.bytes.length,
      json: async () => JSON.parse(value.bytes) } : null; },
    async put(key, bytes, options = {}) {
      const previous = records.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous ||
          options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
      const value = { bytes: String(bytes), etag: String(++serial) }; records.set(key, value); return value;
    },
  };
}

test('private aircraft captures survive a new runtime, warm history serves without providers, and retries repair notification', async (t) => {
  const sqlite = new DatabaseSync(':memory:');
  for (const filename of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql'])
    sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  let failRevision = false;
  const database = { withSession() { return this; }, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...values) { return {
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { if (failRevision && sql.includes('INSERT INTO earth_collection_revision')) throw new Error('Transient notification failure'); return statement.run(...values); },
    }; } };
  } };
  let at = Date.now() - 1000, sourceRequests = 0;
  const now = () => at, env = { EARTH_STORE: bucket(), EARTH_DB: database, EARTH_COLLECTOR_TOKEN: 'e'.repeat(64) };
  const options = { cache: null, now, fetchImpl: async () => { sourceRequests++; throw new Error('Prepared readers cannot acquire providers'); } };
  const runtime = createEarthRuntime(options); t.after(() => { runtime.close(); sqlite.close(); });
  const packet = (captured, latitude) => {
    const normalized = readsbSnapshot({ now: captured / 1000, ac: [{ hex: 'abcdef', flight: 'TEST', lat: latitude, lon: 4.35,
      seen_pos: 0, seen: 0, gs: 300, track: 0, alt_baro: 10000, baro_rate: 0 }] },
    { now: captured, observedAtMs: captured, observedAtSource: 'source' });
    return { schemaVersion: 1, source: 'adsb.lol', collectedAt: new Date(captured).toISOString(),
      scope: { id: 'brussels-250km', type: 'area', latitude: 50.85, longitude: 4.35, radiusKm: 250 },
      observedAtMs: captured, observedAtSource: 'source', records: normalized.records,
      sourceState: { freshness: 'current', cache: 'MISS', cacheAgeMs: 0, ageMs: 0, complete: true, rejectedCount: 0 } };
  };
  const post = (value, authorized = true) => runtime.fetch(new Request('https://example.com/earth/api/collector', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${env.EARTH_COLLECTOR_TOKEN}` } : {}) },
    body: JSON.stringify({ action: 'aircraft', packet: value }) }), env);
  const first = packet(at - 30000, 50.8), second = packet(at, 50.84);
  assert.equal((await post(first, false)).status, 401);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_aircraft_observations').get().n, 0);
  assert.equal((await post(first)).status, 200);
  failRevision = true; assert.equal((await post(second)).status, 503); failRevision = false;
  const retried = await post(second); assert.equal(retried.status, 200);
  const acknowledgment = await retried.json(); assert.equal(acknowledgment.changed, false); assert.equal(acknowledgment.updatesPublished, true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_aircraft_observations').get().n, 2);
  assert.equal(sqlite.prepare('SELECT collected_at FROM earth_collection_revision WHERE id=2').get().collected_at, second.collectedAt);
  assert.equal(sqlite.prepare('SELECT * FROM earth_collection_revision WHERE id=1').get(), undefined);
  const freshRuntime = createEarthRuntime(options); t.after(() => freshRuntime.close());
  const response = await freshRuntime.fetch(new Request('https://example.com/earth/api/aircraft/observations?lat=50.85&lon=4.35&radiusKm=50'), env);
  assert.equal(response.status, 200); const warm = await response.json();
  assert.equal(warm.prepared, true); assert.equal(warm.records[0].positionTimeMs, at);
  assert.equal(warm.history[0].positionTimeMs, at - 30000); assert.equal(warm.records[0].latitude, 50.84);
  assert.equal(warm.stale, false); assert.match(response.headers.get('cache-control'), /public/);
  const outside = await freshRuntime.fetch(new Request('https://example.com/earth/api/aircraft/observations?lat=10&lon=10&radiusKm=50'), env);
  assert.equal(outside.status, 503); assert.equal((await outside.json()).code, 'not-covered');
  assert.equal(sourceRequests, 0);
  at += 121000;
  const stale = await (await freshRuntime.fetch(new Request('https://example.com/earth/api/aircraft/observations?lat=50.85&lon=4.35&radiusKm=50'), env)).json();
  assert.equal(stale.stale, true); assert.equal(stale.records[0].positionTimeMs, second.observedAtMs);
});

test('private ingestion persists history; a fresh runtime serves prepared data with zero source requests', async () => {
  const at = Date.parse('2026-10-11T12:00:00Z'), now = () => at, env = { EARTH_STORE: bucket(), EARTH_COLLECTOR_TOKEN: 'a'.repeat(64) };
  let requests = 0;
  const runtime = createEarthRuntime({ cache: null, now, fetchImpl: async (url) => {
    requests++;
    if (String(url).includes('github.com')) return new Response('', { status: 503 });
    if (String(url).includes('eonet.gsfc')) return Response.json({ events: [] });
    if (String(url).includes('gdacs')) return Response.json({ features: [] });
    return Response.json({ features: [{ id: 'us7000test', geometry: { coordinates: [4, 50] },
      properties: { title: 'M 5 earthquake', time: at - 60000, updated: at - 30000,
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test' } }] });
  } });
  const trigger = (token) => new Request('https://example.com/earth/api/collector', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{"action":"collect"}' });
  assert.equal((await runtime.fetch(trigger(), env)).status, 401);
  assert.equal((await runtime.fetch(trigger('b'.repeat(64)), env)).status, 401);
  assert.equal(requests, 0);
  const collected = await runtime.fetch(trigger(env.EARTH_COLLECTOR_TOKEN), env);
  assert.equal(collected.status, 200); const publication = await collected.json();
  assert.equal(publication.stored, true); assert.ok(publication.snapshots.some((row) => row.source === 'usgs'));
  assert.ok(requests >= 3); runtime.close();
  const reader = createEarthRuntime({ cache: null, now, fetchImpl: async () => { throw new Error('A visitor must not acquire sources'); } });
  const data = await reader.fetch(new Request('https://example.com/earth/api/intelligence?category=disasters'), env);
  assert.equal(data.status, 200); const current = await data.json();
  assert.equal(current.delivery, 'prepared-hosted-data');
  assert.equal(current.indexRecords.find((record) => record.sourceId === 'usgs').observedAt, new Date(at - 60000).toISOString());
  const history = await (await reader.fetch(new Request(`https://example.com/earth/api/history?at=${new Date(at).toISOString()}`), env)).json();
  assert.equal(history.configured, true); assert.ok(history.reports.some((record) => record.sourceId === 'usgs' && record.lat === 50));
  const invalid = new Request('https://example.com/earth/api/collector', { method: 'POST', headers: { authorization: `Bearer ${env.EARTH_COLLECTOR_TOKEN}`, 'content-type': 'application/json' }, body: '{"action":"collect","url":"https://untrusted.example"}' });
  assert.equal((await reader.fetch(invalid, env)).status, 400); reader.close();
});

test('laptop publication and compact heartbeats retain facts, deduplicate history and keep derived analysis separate', async () => {
  let at = Date.parse('2026-10-11T13:00:00Z'); const now = () => at;
  const acquired = await collectEarthSources({}, {}, { now, fetchImpl: async (url) => {
    if (String(url).includes('github.com')) return new Response('', { status: 503 });
    if (String(url).includes('eonet.gsfc')) return Response.json({ events: [] });
    if (String(url).includes('gdacs')) return Response.json({ features: [] });
    return Response.json({ features: [{ id: 'us7000local', geometry: { coordinates: [4, 50] },
      properties: { title: 'M 5 local earthquake', time: at - 60000, updated: at - 30000,
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000local' } }] });
  } });
  const packet = acquired.packet, oldBatchAt = new Date(at - 900000).toISOString();
  const batch = canonicalDiscoveryRecord({ id: 'gdelt:batch:old', sourceId: 'gdelt', kind: 'topic-mention',
    title: 'Topic mention', url: 'https://example.org/report', category: 'economy', themes: ['WB_698_TRADE'],
    indexedAt: oldBatchAt, retrievedAt: oldBatchAt });
  packet.payload.indexRecords.push(batch);
  packet.payload.sources = packet.payload.sources.map((source) => source.id === 'gdelt' ? { ...source, status: 'ready', retrievedAt: new Date(at).toISOString() } : source);
  packet.payload.indexCoverage.sources = packet.payload.indexCoverage.sources.map((source) => source.id === 'gdelt' ? {
    ...source, status: 'ready', generation: oldBatchAt, expiresAt: new Date(at + 86400000).toISOString(),
  } : source);
  const inputDigest = factsDigest(packet.payload.indexRecords);
  assert.equal(await collectionFactsDigest(packet.payload.indexRecords), inputDigest);
  const analysis = { schemaVersion: 1, method: 'deterministic-source-metadata', createdAt: packet.collectedAt, inputDigest,
    changes: { added: 2, revised: 0, withdrawn: 0 }, topics: [{ label: 'Trade', count: 1 }],
    analysis: [{ id: batch.id, labels: ['Locally derived topic'] }] };
  const env = { EARTH_STORE: bucket(), EARTH_COLLECTOR_TOKEN: 'c'.repeat(64) };
  let sourceRequests = 0;
  const runtime = createEarthRuntime({ cache: null, now, fetchImpl: async () => { sourceRequests++; throw new Error('No source requests during publication or serving'); } });
  const post = (body) => runtime.fetch(new Request('https://example.com/earth/api/collector', { method: 'POST',
    headers: { authorization: `Bearer ${env.EARTH_COLLECTOR_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  const published = await post({ action: 'publish', packet, analysis });
  assert.equal(published.status, 200); const initial = await published.json(); assert.equal(initial.analysisStored, true);
  at += 60000;
  const heartbeat = { action: 'heartbeat', collectedAt: new Date(at).toISOString(), inputDigest,
    sources: packet.payload.sources.map((source) => source.status === 'ready' ? { ...source, retrievedAt: new Date(at).toISOString() } : source) };
  const accepted = await post(heartbeat); assert.equal(accepted.status, 200); const checked = await accepted.json();
  for (const row of checked.snapshots) assert.equal(row.id, initial.snapshots.find((previous) => previous.source === row.source).id);
  const current = await (await runtime.fetch(new Request('https://example.com/earth/api/intelligence'), env)).json();
  assert.equal(current.collectedAt, heartbeat.collectedAt);
  assert.equal(current.indexRecords.find((record) => record.sourceId === 'usgs').retrievedAt, heartbeat.collectedAt);
  assert.equal(current.indexRecords.find((record) => record.sourceId === 'gdelt').retrievedAt, oldBatchAt);
  assert.equal(current.indexRecords.some((record) => record.labels), false);
  const derived = await (await runtime.fetch(new Request('https://example.com/earth/api/analysis'), env)).json();
  assert.equal(derived.derived, true); assert.equal(derived.currentFactsMatch, true); assert.equal(derived.createdAt, packet.collectedAt);
  assert.equal((await post({ ...heartbeat, inputDigest: '0'.repeat(64) })).status, 409);
  assert.equal((await post({ action: 'publish', packet, analysis: { ...analysis, inputDigest: '0'.repeat(64) } })).status, 400);
  assert.equal((await post({ action: 'publish', packet, analysis: { ...analysis, analysis: [{ id: 'invented', labels: ['unsupported'] }] } })).status, 400);
  // A competing publisher changes facts after the heartbeat's initial read but
  // before its conditional pointer write. It must not be overwritten or archived.
  at += 60000;
  const originalPut = env.EARTH_STORE.put.bind(env.EARTH_STORE); let compete = true;
  env.EARTH_STORE.put = async (key, bytes, options) => {
    if (key === 'collection/current-intelligence.json' && compete) {
      compete = false;
      const currentObject = await env.EARTH_STORE.get(key), competing = await currentObject.json();
      competing.collectedAt = new Date(at - 1000).toISOString();
      competing.payload.indexRecords = competing.payload.indexRecords.map((record) => record.sourceId === 'usgs' ? { ...record, title: 'Revised by competing publication' } : record);
      await originalPut(key, JSON.stringify(competing));
    }
    return originalPut(key, bytes, options);
  };
  assert.equal((await post({ ...heartbeat, collectedAt: new Date(at).toISOString() })).status, 409);
  const retained = await (await runtime.fetch(new Request('https://example.com/earth/api/intelligence'), env)).json();
  assert.equal(retained.indexRecords.find((record) => record.sourceId === 'usgs').title, 'Revised by competing publication');
  const afterConflict = await (await runtime.fetch(new Request('https://example.com/earth/api/history'), env)).json();
  assert.equal(afterConflict.snapshots.some((row) => row.at === new Date(at).toISOString()), false);
  assert.equal(sourceRequests, 0); runtime.close();
});

test('private publication and heartbeat announce only durable migrated SQLite revisions, with immutable source facts', async (t) => {
  const sqlite = new DatabaseSync(':memory:');
  for (const filename of ['0000_glossy_overlord.sql', '0001_collection_revision.sql']) {
    sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  }
  const database = {
    withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { bind(...values) { return {
        async first() { return statement.get(...values) || null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return statement.run(...values); },
      }; } };
    },
  };
  // The public update singleton validates against real UTC, rather than the
  // injected application clock. Stay close to it while advancing acquisition.
  let at = Date.now() - 1000;
  const stamp = (value) => new Date(value).toISOString(), now = () => at;
  const env = { EARTH_STORE: bucket(), EARTH_DB: database, EARTH_COLLECTOR_TOKEN: 'd'.repeat(64) };
  let sourceRequests = 0;
  const runtime = createEarthRuntime({ cache: null, now, fetchImpl: async () => {
    sourceRequests++; throw new Error('Publication and stream delivery must not acquire providers');
  } });
  const clients = [];
  t.after(async () => {
    for (const client of clients) { client.abort.abort(); await client.reader.cancel(); }
    runtime.close(); sqlite.close();
  });
  const post = (body) => runtime.fetch(new Request('https://example.com/earth/api/collector', {
    method: 'POST', headers: { authorization: `Bearer ${env.EARTH_COLLECTOR_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const current = async () => (await env.EARTH_STORE.get('collection/current-intelligence.json')).json();
  const durableRevision = () => ({ ...sqlite.prepare('SELECT * FROM earth_collection_revision WHERE id = 1').get() });
  const connect = async () => {
    const abort = new AbortController();
    const response = await runtime.fetch(new Request('https://example.com/earth/api/updates', { signal: abort.signal }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const client = { abort, reader: response.body.getReader() }; clients.push(client); return client;
  };
  async function nextCollection(client) {
    let timer;
    const operation = (async () => {
      for (let index = 0; index < 12; index++) {
        const part = await client.reader.read(); assert.equal(part.done, false);
        const frame = new TextDecoder().decode(part.value);
        if (frame.includes('event: collection\n')) {
          const event = JSON.parse(/^data: (.+)$/m.exec(frame)[1]);
          assert.equal(/^id: (.+)$/m.exec(frame)[1], event.revision);
          assert.deepEqual(Object.keys(event), ['schemaVersion', 'revision', 'collectedAt', 'inputDigest', 'recordCount']);
          assert.equal(frame.includes('M 5 source earthquake'), false, 'The public stream carries bounded revision metadata, not report bodies');
          return event;
        }
      }
      throw new Error('Collection stream did not deliver a bounded revision');
    })();
    try {
      return await Promise.race([operation, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Collection stream test deadline')), 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const record = canonicalDiscoveryRecord({ id: 'usgs:durable-test', sourceId: 'usgs', source: 'USGS',
    category: 'disasters', title: 'M 5 source earthquake', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/durable-test',
    observedAt: stamp(at - 300000), updatedAt: stamp(at - 60000), retrievedAt: stamp(at), lat: 50, lon: 4, magnitude: 5 });
  const packet = { schemaVersion: 1, collectedAt: stamp(at), payload: {
    reports: [record], indexRecords: [record], retrievedAt: stamp(at),
    sources: [{ id: 'usgs', name: 'USGS', status: 'ready', retrievedAt: stamp(at) }],
    indexCoverage: { schemaVersion: 1, sources: [{ id: 'usgs', status: 'ready', categories: ['disasters'],
      generation: `usgs:${stamp(at)}`, expiresAt: stamp(at + 86400000) }] },
  } };
  const inputDigest = await collectionFactsDigest(packet.payload.indexRecords);
  const analysis = { schemaVersion: 1, method: 'deterministic-source-metadata', createdAt: packet.collectedAt, inputDigest,
    changes: { added: 1, revised: 0, withdrawn: 0 }, topics: [{ label: 'Earthquakes', count: 1 }],
    analysis: [{ id: record.id, labels: ['Locally derived topic'] }] };
  const publication = await post({ action: 'publish', packet, analysis });
  assert.equal(publication.status, 200);
  const accepted = await publication.json();
  assert.equal(accepted.stored, true); assert.equal(accepted.updatesPublished, true);
  const first = durableRevision();
  assert.equal(first.collected_at, packet.collectedAt); assert.equal(first.input_digest, inputDigest); assert.equal(first.record_count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM earth_collection_revision').get().count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM earth_observations').get().count, 1);
  const initialPrepared = await current();
  assert.deepEqual(initialPrepared.payload.indexRecords, [record]);
  const client = await connect(), initialEvent = await nextCollection(client);
  assert.equal(initialEvent.revision, first.revision); assert.equal(initialEvent.inputDigest, inputDigest); assert.equal(initialEvent.recordCount, 1);
  assert.deepEqual((await current()).payload.indexRecords, [record], 'Reading the stream leaves stored source facts unchanged');

  at += 60000;
  const heartbeat = { action: 'heartbeat', collectedAt: stamp(at), inputDigest,
    sources: packet.payload.sources.map((source) => ({ ...source, retrievedAt: stamp(at) })) };
  const checked = await post(heartbeat); assert.equal(checked.status, 200);
  assert.equal((await checked.json()).updatesPublished, true);
  const second = durableRevision(), laterEvent = await nextCollection(client);
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.collected_at, heartbeat.collectedAt); assert.equal(second.input_digest, first.input_digest);
  assert.equal(laterEvent.revision, second.revision); assert.equal(laterEvent.collectedAt, heartbeat.collectedAt);
  const afterHeartbeat = await current();
  assert.deepEqual(afterHeartbeat.payload.indexRecords, [{ ...record, retrievedAt: heartbeat.collectedAt }]);
  assert.equal(await collectionFactsDigest(afterHeartbeat.payload.indexRecords), inputDigest);
  assert.deepEqual(packet.payload.indexRecords, [record], 'The uploaded observation itself remains unchanged');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM earth_observations').get().count, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(DISTINCT snapshot_id) AS count FROM earth_observations').get().count, 1);
  const archived = await (await runtime.fetch(new Request(`https://example.com/earth/api/history?at=${encodeURIComponent(heartbeat.collectedAt)}`), env)).json();
  assert.equal(archived.reports[0].retrievedAt, packet.collectedAt);
  assert.equal(archived.reports[0].observedAt, record.observedAt);

  at += 1000;
  const failedPacket = structuredClone(packet); failedPacket.collectedAt = stamp(at);
  failedPacket.payload.indexRecords[0].title = 'Changed publication that storage rejected';
  const failedAnalysis = { ...analysis, createdAt: failedPacket.collectedAt,
    inputDigest: await collectionFactsDigest(failedPacket.payload.indexRecords) };
  const originalPut = env.EARTH_STORE.put.bind(env.EARTH_STORE);
  env.EARTH_STORE.put = async (key, ...args) => {
    if (key === 'collection/current-intelligence.json') throw new Error('Controlled storage failure');
    return originalPut(key, ...args);
  };
  try { assert.equal((await post({ action: 'publish', packet: failedPacket, analysis: failedAnalysis })).status, 503); }
  finally { env.EARTH_STORE.put = originalPut; }
  assert.deepEqual(durableRevision(), second, 'Failed storage does not announce a successful revision');
  assert.deepEqual(await current(), afterHeartbeat);
  assert.equal((await post({ ...heartbeat, collectedAt: stamp(at), inputDigest: '0'.repeat(64) })).status, 409);
  assert.deepEqual(durableRevision(), second, 'A conflicting baseline cannot advance the durable revision');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM earth_observations').get().count, 2);
  const resumed = await connect();
  assert.equal((await nextCollection(resumed)).revision, second.revision, 'Reconnect replays the retained durable revision after failed/conflicting ingestion');
  const served = await (await runtime.fetch(new Request('https://example.com/earth/api/intelligence'), env)).json();
  assert.deepEqual(served.indexRecords, afterHeartbeat.payload.indexRecords);
  assert.equal(sourceRequests, 0);
});
