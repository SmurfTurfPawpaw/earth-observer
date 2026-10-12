import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { acquireUsgsCatalogInterval, restoreUsgsCatalogCandidate, splitUsgsCatalogInterval, usgsCatalogUrl } from './usgs-catalog-interval.js';
import { createWorldArchiveCandidate } from '../../worker/world-archive.js';

const range = { from: '2026-10-11T00:00:00.000Z', to: '2026-10-11T00:10:00.000Z' }, now = () => Date.parse('2026-10-12T04:00:00.000Z');
const feature = (at) => ({ type: 'Feature', id: 'test-interval', properties: { type: 'earthquake', time: Date.parse(at), updated: Date.parse(at) + 1000,
  mag: 4.5, title: 'TEST ONLY São Tomé', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/test-interval' }, geometry: { type: 'Point', coordinates: [4, 50, 5] } });
function upstream({ features = [], count = features.length, body, empty = false, queryRange = range } = {}) {
  const raw = body ?? ` ${JSON.stringify({ type: 'FeatureCollection', metadata: { count: features.length, status: 200, url: usgsCatalogUrl('query', queryRange).href }, features })}\n`;
  const calls = [];
  return { calls, raw, fetchImpl: async (url, options) => { calls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://earthquake.usgs.gov'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return new Response(new URL(url).pathname.endsWith('/count') ? String(count) : empty ? '' : raw, { headers: { 'content-type': 'application/json' } }); } };
}
test('portable acquisition preserves unsliced UTF-8 originals and produces the existing publisher identity at the inclusive source end', async () => {
  const f = upstream({ features: [feature(range.to)] }), value = await acquireUsgsCatalogInterval({ range, now, fetchImpl: f.fetchImpl });
  assert.equal(value.status, 'acquired'); assert.equal(value.records.length, 1); assert.equal(value.records[0].observedAt, range.to);
  assert.equal(value.body, f.raw); assert.deepEqual(value.rawBytes, new TextEncoder().encode(f.raw));
  assert.equal(value.rawSha256, createHash('sha256').update(f.raw).digest('hex'));
  assert.equal((await createWorldArchiveCandidate(value, { now })).chunkId, value.chunkId);
  assert.equal(f.calls.length, 2); assert.equal(new URL(f.calls[1].url).searchParams.has('offset'), false);
  const metadata = Object.fromEntries(['schemaVersion', 'scopeId', 'kind', 'range', 'expectedCount', 'capturedAt', 'rawSha256', 'sourceBytes', 'chunkId', 'snapshotId'].map((key) => [key, value[key]]));
  const restored = await restoreUsgsCatalogCandidate({ body: f.raw, metadata, now: () => now() + 600000 });
  assert.equal(restored.capturedAt, value.capturedAt); assert.equal(restored.chunkId, value.chunkId);
  await assert.rejects(restoreUsgsCatalogCandidate({ body: `${f.raw} `, metadata, now }), /integrity/);
});
test('only a genuine count-matched empty GeoJSON certifies quiet coverage; missing body and count drift remain gaps', async () => {
  const genuine = upstream(), acquired = await acquireUsgsCatalogInterval({ range, now, fetchImpl: genuine.fetchImpl });
  assert.equal(acquired.status, 'acquired'); assert.equal(acquired.expectedCount, 0); assert.equal(acquired.records.length, 0); assert.equal(acquired.body, genuine.raw);
  const absent = upstream({ empty: true }); assert.equal((await acquireUsgsCatalogInterval({ range, now, fetchImpl: absent.fetchImpl })).status, 'gap');
  const drift = upstream({ features: [feature(range.from)], count: 0 }); assert.equal((await acquireUsgsCatalogInterval({ range, now, fetchImpl: drift.fetchImpl })).status, 'changed-catalog');
});
test('dense intervals split before query and preserve their exact inclusive seam without an arbitrary source URL', async () => {
  const f = upstream({ count: 251 }), split = await acquireUsgsCatalogInterval({ range, now, fetchImpl: f.fetchImpl });
  assert.equal(split.status, 'split-required'); assert.equal(f.calls.length, 1); assert.equal(split.parts[0].to, split.parts[1].from);
  assert.equal(split.parts[0].from, range.from); assert.equal(split.parts[1].to, range.to);
  assert.throws(() => splitUsgsCatalogInterval({ from: range.from, to: '2026-10-11T00:00:01.000Z' }), /split/);
  const bad = upstream({ queryRange: { ...range, to: '2026-10-11T00:20:00.000Z' } });
  await assert.rejects(acquireUsgsCatalogInterval({ range, now, fetchImpl: bad.fetchImpl }), /declared/);
  await assert.rejects(acquireUsgsCatalogInterval({ range: { ...range, url: 'https://example.com' }, now, fetchImpl: f.fetchImpl }), /bounds/);
});
test('invalid original UTF-8, future intervals and aborted requests cannot acquire a replacement body', async () => {
  let requests = 0;
  const fetchImpl = async (url) => { requests++; return new Response(url.endsWith('/count?') ? '0' : requests === 1 ? '0' : new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }); };
  await assert.rejects(acquireUsgsCatalogInterval({ range, now, fetchImpl }), /encoded|encoding/i);
  await assert.rejects(acquireUsgsCatalogInterval({ range: { from: range.from, to: '2026-10-13T00:00:00.000Z' }, now, fetchImpl }), /completed/);
  const abort = new AbortController(); abort.abort(); requests = 0;
  await assert.rejects(acquireUsgsCatalogInterval({ range, now, fetchImpl, signal: abort.signal })); assert.equal(requests, 0);
});
