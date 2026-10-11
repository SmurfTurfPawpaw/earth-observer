import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthRuntime } from './index.js';

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
