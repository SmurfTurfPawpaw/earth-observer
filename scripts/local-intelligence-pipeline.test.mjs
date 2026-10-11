import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalPipeline, factsDigest, LOCAL_PUBLISH_URL, MAX_LOCAL_ANALYSIS_BYTES } from './local-intelligence-pipeline.mjs';
import { normalizeGdelt } from '../server/hosted/intelligence-sources.js';
import { gdeltQueryUrl } from '../server/hosted/gdelt-query.js';
import { GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';

const CLOCK = Date.parse('2026-10-11T18:00:00.000Z'), iso = (at) => new Date(at).toISOString(), TOKEN = 'synthetic_test_token_12345678901234567890';

async function directory(t) {
  const parent = path.resolve(tmpdir()), target = await mkdtemp(path.join(parent, 'earth-local-pipeline-'));
  assert.equal(path.dirname(path.resolve(target)), parent);
  assert.ok(path.basename(target).startsWith('earth-local-pipeline-'));
  t.after(() => rm(target, { recursive: true, force: true })); return target;
}

function sources() {
  let clock = CLOCK, revision = 0, empty = false, sink = () => Response.json({ stored: true });
  const requests = [], publications = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input); requests.push(url);
    if (url === LOCAL_PUBLISH_URL) {
      assert.equal(options.method, 'POST'); assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(options.redirect, 'error'); const body = JSON.parse(options.body); publications.push(body);
      return sink(body);
    }
    if (url === GDELT_SNAPSHOT_URL) {
      const retrievedAt = iso(clock), categories = Object.fromEntries(['geopolitics', 'economy', 'disasters'].map((category) => [category, {
        queryUrl: gdeltQueryUrl({ category }), retrievedAt, reports: normalizeGdelt({ articles: [{ title: `Source ${category} metadata`,
          url: `https://publisher.test/${category}`, seendate: iso(CLOCK - 60000) }] }, retrievedAt, category),
      }]));
      return Response.json({ schemaVersion: 1, generatedAt: retrievedAt,
        source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
        coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: ['geopolitics', 'economy', 'disasters'] }, categories });
    }
    if (url === EONET_QUERY_URL) return Response.json({ events: [{ id: 'EONET_123', title: 'Source wildfire', categories: [{ id: 'wildfires' }],
      sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/incident/source' }], closed: null,
      geometry: [{ date: iso(CLOCK - 7200000), type: 'Point', coordinates: [4, 50] }] }] });
    if (url === 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson') return Response.json({ features: empty ? [] : [{
      id: 'qa-quake', geometry: { type: 'Point', coordinates: [4, 50, 12] }, properties: { title: 'Source earthquake', mag: 5.1,
        status: 'reviewed', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/qa-quake', time: CLOCK - 300000, updated: CLOCK - 60000 + revision },
    }] });
    if (url.startsWith('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?')) return Response.json({ features: [{
      geometry: { type: 'Point', coordinates: [4.2, 50.2] }, properties: { eventid: 12, episodeid: 1, eventtype: 'FL', name: 'Source flood',
        url: { report: 'https://www.gdacs.org/report.aspx?eventid=12&eventtype=FL' }, fromdate: iso(CLOCK - 3600000), datemodified: iso(CLOCK - 60000),
        alertlevel: 'Green', affectedcountries: [{ iso2: 'BE' }] },
    }] });
    throw new Error('Only fixed metadata sources and the owned writer are permitted');
  };
  return { requests, publications, fetchImpl, now: () => clock, advance(ms = 61000) { clock += ms; },
    revise(value) { revision = value; }, empty() { empty = true; }, sink(callback) { sink = callback; } };
}

test('laptop processing runs inference only for new/revised metadata, deduplicates retrieval-only updates and preserves actual facts/dates', async (t) => {
  const stateDirectory = await directory(t), source = sources(), jobs = [];
  const pipeline = createLocalPipeline({ stateDirectory, fetchImpl: source.fetchImpl, now: source.now,
    infer: async (records) => {
      jobs.push(records.map((record) => record.id));
      records[0].title = 'Mutated local inference input';
      return records.map((record) => ({ id: record.id, labels: ['Optional local derived label'] }));
    } });
  const first = await pipeline.cycle();
  assert.equal(first.changedRecords, 6); assert.equal(first.analysis.changes.added, 6); assert.equal(jobs.length, 1);
  assert.equal(first.packet.payload.indexRecords.some((record) => record.title === 'Mutated local inference input'), false);
  assert.equal(first.analysis.createdAt, first.packet.collectedAt); assert.equal(first.analysis.inputDigest, factsDigest(first.packet.payload.indexRecords));
  assert.ok(Buffer.byteLength(JSON.stringify(first.analysis)) <= MAX_LOCAL_ANALYSIS_BYTES);
  assert.ok(first.analysis.topics.some((topic) => topic.label === 'Source: usgs' && topic.count === 1));
  const saved = await readFile(path.join(stateDirectory, 'facts.json'), 'utf8');
  source.advance(); const unchanged = await pipeline.cycle();
  assert.equal(unchanged.changedRecords, 0); assert.deepEqual(unchanged.analysis.changes, { added: 0, revised: 0, withdrawn: 0 });
  assert.equal(jobs.length, 1); assert.equal(unchanged.inputDigest, first.inputDigest);
  assert.equal(await readFile(path.join(stateDirectory, 'facts.json'), 'utf8'), saved, 'unchanged polls write no complete facts file');
  assert.notEqual(unchanged.packet.payload.indexRecords.find((record) => record.sourceId === 'usgs').retrievedAt,
    first.packet.payload.indexRecords.find((record) => record.sourceId === 'usgs').retrievedAt);
  source.advance(); source.revise(120000); const revised = await pipeline.cycle();
  assert.equal(revised.revisedRecords, 1); assert.equal(revised.analysis.changes.revised, 1); assert.deepEqual(jobs[1], ['usgs:qa-quake']);
  assert.notEqual(revised.inputDigest, first.inputDigest);
  source.advance(); source.empty(); const removed = await pipeline.cycle();
  assert.equal(removed.analysis.changes.withdrawn, 1); assert.equal(jobs.length, 2, 'absence alone never invokes interpretation of missing data');
  assert.equal(source.publications.length, 0); assert.ok(source.requests.every((url) => !url.includes('.zip') && !url.startsWith('https://publisher.test/')));
  const sorted = first.packet.payload.indexRecords, reversed = [...sorted].reverse();
  assert.equal(factsDigest(reversed), factsDigest(sorted));
  assert.equal(factsDigest(sorted.map((record) => ({ ...record, retrievedAt: iso(CLOCK + 999000) }))), factsDigest(sorted));
});

test('published baselines use compact unchanged heartbeats and a 409 falls back to one full publication without reinference', async (t) => {
  const stateDirectory = await directory(t), source = sources(); let inferenceJobs = 0;
  const pipeline = createLocalPipeline({ stateDirectory, fetchImpl: source.fetchImpl, now: source.now, publishUrl: LOCAL_PUBLISH_URL,
    publishCredential: TOKEN, infer: async () => { inferenceJobs++; return []; } });
  const first = await pipeline.cycle(); assert.equal(first.published, true); assert.equal(source.publications[0].action, 'publish');
  source.advance(); const second = await pipeline.cycle(); assert.equal(second.published, true);
  const heartbeat = source.publications[1]; assert.equal(heartbeat.action, 'heartbeat'); assert.equal(heartbeat.packet, undefined);
  assert.equal(heartbeat.inputDigest, first.inputDigest); assert.equal(heartbeat.collectedAt, second.packet.collectedAt);
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeat)) < Buffer.byteLength(JSON.stringify(source.publications[0])));
  assert.equal(inferenceJobs, 1);
  source.sink((body) => body.action === 'heartbeat' ? new Response(null, { status: 409 }) : Response.json({ stored: true }));
  source.advance(); const recovered = await pipeline.cycle(); assert.equal(recovered.published, true);
  assert.deepEqual(source.publications.slice(-2).map((body) => body.action), ['heartbeat', 'publish']);
  assert.equal(source.publications.at(-1).analysis.createdAt, recovered.packet.collectedAt); assert.equal(inferenceJobs, 1);
  assert.deepEqual(source.publications.at(-1).analysis.changes, { added: 0, revised: 0, withdrawn: 0 });

  source.sink(() => new Response(null, { status: 503 }));
  source.advance(); const queued = await pipeline.cycle(); assert.equal(queued.status, 'queued');
  const outboxFile = path.join(stateDirectory, 'outbox.json'), retained = JSON.parse(await readFile(outboxFile, 'utf8'));
  delete retained.packet; // Simulate a crash after compact heartbeat admission, before its first send.
  const stale = retained.body.sources.find((source) => source.id === 'gdacs'); stale.status = 'stale'; stale.stale = true;
  await writeFile(outboxFile, JSON.stringify(retained));
  source.advance(); source.sink((body) => body.action === 'heartbeat' ? new Response(null, { status: 409 }) : Response.json({ stored: true }));
  const restarted = createLocalPipeline({ stateDirectory, fetchImpl: source.fetchImpl, now: source.now,
    publishUrl: LOCAL_PUBLISH_URL, publishCredential: TOKEN });
  assert.equal((await restarted.flushOutbox()).published, true);
  const fallback = source.publications.at(-1), readyAt = retained.body.sources.find((source) => source.id === 'usgs').retrievedAt;
  const coverage = (packet, id) => packet.payload.indexCoverage.sources.find((entry) => entry.id === id);
  const record = (packet, id) => packet.payload.indexRecords.find((entry) => entry.sourceId === id);
  assert.equal(record(fallback.packet, 'usgs').retrievedAt, readyAt);
  assert.equal(coverage(fallback.packet, 'usgs').generation, `usgs:${readyAt}`);
  assert.equal(coverage(fallback.packet, 'usgs').expiresAt, iso(Date.parse(readyAt) + 86400000));
  assert.equal(record(fallback.packet, 'gdacs').retrievedAt, record(first.packet, 'gdacs').retrievedAt);
  assert.equal(coverage(fallback.packet, 'gdacs').generation, coverage(first.packet, 'gdacs').generation);
  assert.equal(coverage(fallback.packet, 'gdacs').expiresAt, coverage(first.packet, 'gdacs').expiresAt);
  assert.equal(coverage(fallback.packet, 'gdacs').status, 'stale');
  assert.equal(record(fallback.packet, 'gdelt').retrievedAt, record(first.packet, 'gdelt').retrievedAt);
  assert.equal(coverage(fallback.packet, 'gdelt').generation, coverage(first.packet, 'gdelt').generation);
  assert.equal(coverage(fallback.packet, 'gdelt').expiresAt, coverage(first.packet, 'gdelt').expiresAt);
  assert.equal(fallback.analysis.createdAt, retained.body.collectedAt);
  assert.equal(fallback.analysis.inputDigest, first.inputDigest); assert.equal(inferenceJobs, 1);
});

test('failed publication queues actual capture and derived analysis, honors Retry-After and recovers a pre-facts crash without reinference', async (t) => {
  const stateDirectory = await directory(t), source = sources(); let jobs = 0;
  source.sink(() => new Response('temporarily unavailable', { status: 503, headers: { 'retry-after': '120' } }));
  const options = { stateDirectory, fetchImpl: source.fetchImpl, now: source.now, publishUrl: LOCAL_PUBLISH_URL,
    publishCredential: TOKEN, infer: async (records) => { jobs++; return records.map((record) => ({ id: record.id, labels: ['Local bucket'] })); } };
  const first = await createLocalPipeline(options).cycle(); assert.equal(first.status, 'queued');
  assert.equal(first.retryAt, iso(CLOCK + 120000));
  const queued = await readFile(path.join(stateDirectory, 'outbox.json'), 'utf8'); assert.equal(queued.includes(TOKEN), false);
  const calls = source.requests.length; source.advance(60000);
  await unlink(path.join(stateDirectory, 'facts.json'));
  const restarted = createLocalPipeline(options), paused = await restarted.cycle(); assert.equal(paused.status, 'backoff');
  assert.equal(source.requests.length, calls); assert.equal(jobs, 1);
  assert.ok(await readFile(path.join(stateDirectory, 'facts.json'), 'utf8'), 'pending publication recovers the missing local facts commit');
  source.advance(60000); source.sink(() => Response.json({ stored: true }));
  const flushed = await restarted.flushOutbox(); assert.equal(flushed.published, true); assert.equal(jobs, 1);
  const retry = source.publications.at(-1); assert.equal(retry.packet.collectedAt, iso(CLOCK)); assert.equal(retry.analysis.createdAt, iso(CLOCK));
  assert.deepEqual(retry, JSON.parse(queued).body, 'outbox replay is idempotent and retains the exact original capture');
  assert.equal((await restarted.status()).lastPublishedDigest, first.inputDigest);
  await restarted.cycle(); assert.equal(jobs, 1, 'restart does not reprocess unchanged recovered facts');
});

test('optional inference timeout or invalid oversized labels leaves deterministic metadata analysis intact', async (t) => {
  for (const infer of [() => new Promise(() => {}), async () => [{ id: 'unregistered', labels: ['x'.repeat(100000)] }]]) {
    const stateDirectory = await directory(t), source = sources();
    const result = await createLocalPipeline({ stateDirectory, fetchImpl: source.fetchImpl, now: source.now, infer, inferTimeoutMs: 10 }).cycle();
    assert.ok(['timeout', 'unavailable'].includes(result.inferenceStatus)); assert.equal(result.analysis.method, 'deterministic-source-metadata');
    assert.equal(result.analysis.changes.added, 6); assert.ok(Buffer.byteLength(JSON.stringify(result.analysis)) <= MAX_LOCAL_ANALYSIS_BYTES);
    assert.ok(result.packet.payload.indexRecords.every((record) => record.verification && record.retrievedAt));
  }
  assert.throws(() => createLocalPipeline({ publishUrl: 'https://arbitrary.example/collector', publishCredential: TOKEN }), /fixed owned/);
  assert.throws(() => createLocalPipeline({ publishUrl: LOCAL_PUBLISH_URL, publishCredential: 'bad secret' }), /credential format/);
});
