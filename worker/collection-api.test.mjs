import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthRuntime } from './index.js';
import { collectEarthSources } from './collector.js';
import { collectionFactsDigest } from './collection-publication.js';
import { factsDigest } from '../scripts/local-intelligence-pipeline.mjs';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';

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
