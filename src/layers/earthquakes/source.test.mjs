import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsgsEarthquakeSource, validateStoredEarthquakeSnapshot, EARTHQUAKE_CACHE_KEY, EARTHQUAKE_SOURCE_LIMITS } from './source.js';
import { decodeUsgsLiveDay, usgsLiveDayOverview, USGS_LIVE_DAY } from '../../core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from '../../core/plugin-evidence.js';
import { pluginRevision } from '../../core/live-updates.js';

const NOW = Date.parse('2026-10-12T02:55:53.224Z'), iso = ms => new Date(ms).toISOString(), clone = value => structuredClone(value);
// Exact mounted DTO names and scientific row shape, reconstructed through the
// real provider codec. The fixed dates/ID also appear in the v38 cloud proof.
async function snapshot({ fence = 1, mag = 4.2, eventType = 'earthquake' } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection',
    metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl, generated: NOW - 45224, count: 1 },
    features: [{ type: 'Feature', id: 'us6000u1iz', geometry: { type: 'Point', coordinates: [71.007, 36.6753, 198.608] },
      properties: { mag, place: '26 km SE of Jurm, Afghanistan', time: 1791702467437, updated: 1791703346040,
        type: eventType, status: 'reviewed', title: 'M 4.2 - 26 km SE of Jurm, Afghanistan',
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz' } }] }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), factsDigest = await pluginFactsDigest(decoded.canonicalFacts),
    id = `receipt:${await pluginFactsDigest({ fence, factsDigest })}`, overview = usgsLiveDayOverview(decoded);
  return { schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId, kind: 'observation-feed',
      name: 'USGS M2.5+ day seismic reports', sourceUrl: USGS_LIVE_DAY.sourceUrl,
      rights: { status: 'reviewed-public-display', attribution: 'U.S. Geological Survey' } },
    scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, meaning: 'Source-reported seismic observations.' },
    receipt: { id, fence, capturedAt: iso(NOW - 19559), recordedAt: iso(NOW - 18687), factsDigest,
      rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview), sourceUpdatedAt: decoded.sourceGeneratedAt, sourceVersion: null },
    check: { checkedAt: iso(NOW - 19559), nextCheckAt: iso(NOW + 41313), lastSuccessfulAt: iso(NOW - 18687), status: 'ready', sourceGeneratedAt: decoded.sourceGeneratedAt },
    records: decoded.canonicalFacts.records, version: id, factualEditionAgeMs: 19559, retainedSourceGenerationAgeMs: 45224,
    sourceGenerationAgeMs: 45224, stale: false, overview, coverage: { complete: true, recordCount: decoded.canonicalFacts.records.length, meaning: 'Complete qualifying retained cohort.' } };
}
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const revision = value => pluginRevision({ schemaVersion: 1, pluginId: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId,
  receiptId: value.receipt.id, fence: value.receipt.fence, factsDigest: value.receipt.factsDigest, recordedAt: value.receipt.recordedAt });
function store(initial) {
  let value = initial; const writes = [];
  return { writes, get: async key => { assert.equal(key, EARTHQUAKE_CACHE_KEY); return clone(value); },
    put: async (key, next) => { assert.equal(key, EARTHQUAKE_CACHE_KEY); value = clone(next); writes.push(next); } };
}

test('both reviewed mounts read only retained data and preserve all scientific and receipt/check clocks', async () => {
  const body = await snapshot({ eventType: 'quarry blast' });
  for (const baseUrl of ['/', '/earth/']) {
    const calls = [], device = store(), source = createUsgsEarthquakeSource({ baseUrl, now: () => NOW, store: device,
      fetchImpl: async (url, init) => { calls.push(url); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); return response(body); } });
    const result = await source.getSnapshot(); assert.deepEqual(calls, [`${baseUrl}api/layers/earthquakes`]);
    assert.deepEqual(result.records, body.records); assert.deepEqual(result.receipt, body.receipt); assert.deepEqual(result.check, body.check);
    assert.equal(result.records[0].eventType, 'quarry blast'); assert.equal(result.sourceGenerationAgeMs, 45224);
    assert.equal(device.writes.length, 1); assert.equal(revision(body).receiptId, body.receipt.id);
  }
});

test('a validated dated cache paints before a delayed stored GET; corrupt fresh data cannot replace it', async () => {
  const body = await snapshot(), device = store({ schemaVersion: 1, savedAt: NOW - 90000, snapshot: body }), began = Promise.withResolvers(), network = Promise.withResolvers(), painted = [];
  const source = createUsgsEarthquakeSource({ now: () => NOW, store: device, fetchImpl: () => { began.resolve(); return network.promise; } });
  const work = source.getSnapshot({ onCached: value => painted.push(value) }); await began.promise;
  assert.equal(painted.length, 1); assert.equal(painted[0].sourceGenerationAgeMs, 135224); assert.equal(painted[0].stale, true);
  assert.equal(painted[0].receipt.recordedAt, body.receipt.recordedAt); assert.equal(painted[0].check.checkedAt, body.check.checkedAt);
  const bad = clone(body); bad.records[0].mag = 9; network.resolve(response(bad)); await assert.rejects(work, /incompatible/);
  assert.equal(device.writes.length, 0);
});

test('protocol, factual digest, membership and response bounds fail closed without a provider fallback', async () => {
  const body = await snapshot();
  for (const change of [value => { value.receipt.id = value.receipt.id.slice(8); }, value => { value.receipt.fence = 0; },
    value => { value.knownAt = value.receipt.recordedAt; }, value => { value.scope.windowHours = 168; },
    value => { value.coverage.complete = false; }, value => { value.records[0].sourceUrl = 'https://example.com/'; },
    value => { value.records.push(value.records[0]); }, value => { value.overview.sourceGeneratedAt = iso(NOW); }]) {
    const bad = clone(body); change(bad); const calls = [], device = store();
    const source = createUsgsEarthquakeSource({ now: () => NOW, store: device, fetchImpl: async url => { calls.push(url); return response(bad); } });
    await assert.rejects(source.getSnapshot()); assert.deepEqual(calls, ['/api/layers/earthquakes']); assert.equal(device.writes.length, 0);
  }
  for (const reply of [new Response('{}', { status: 503 }), new Response('x'.repeat(EARTHQUAKE_SOURCE_LIMITS.bytes + 1), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } })]) {
    const device = store(); await assert.rejects(createUsgsEarthquakeSource({ now: () => NOW, store: device, fetchImpl: async () => reply }).getSnapshot()); assert.equal(device.writes.length, 0);
  }
});

test('source publication fences handle A/B/A, older in-flight results and equal-fence conflicts', async () => {
  const a = await snapshot(), b = await snapshot({ fence: 2, mag: 4.8 }), reverted = await snapshot({ fence: 3 }), device = store();
  let next = a, pending, began;
  const source = createUsgsEarthquakeSource({ now: () => NOW, store: device, fetchImpl: () => {
    if (pending) { began.resolve(); return pending.promise; } return response(next);
  } });
  await source.getSnapshot(); pending = Promise.withResolvers(); began = Promise.withResolvers();
  const older = source.getSnapshot(); await began.promise; assert.equal(source.invalidate(revision(reverted)), true);
  await assert.rejects(older, { name: 'AbortError' }); pending.resolve(response(b)); pending = null;
  next = reverted; const result = await source.getSnapshot(); assert.equal(result.receipt.fence, 3); assert.equal(result.receipt.factsDigest, a.receipt.factsDigest);
  assert.equal(source.invalidate(revision(b)), false); next = b; await assert.rejects(source.getSnapshot(), /older/);
  next = clone(reverted); next.receipt.id = `receipt:${'f'.repeat(64)}`; next.version = next.receipt.id;
  await assert.rejects(source.getSnapshot(), /older/); assert.equal(device.writes.length, 2);
});

test('caller cancellation fences delayed cache and body completion, with no writes or late paint', async () => {
  const body = await snapshot(), cache = Promise.withResolvers(), owner = new AbortController(); let fetches = 0, paints = 0, writes = 0;
  const source = createUsgsEarthquakeSource({ now: () => NOW, store: { get: () => cache.promise, put: () => { writes++; } },
    fetchImpl: () => { fetches++; return response(body); } });
  const work = source.getSnapshot({ signal: owner.signal, onCached: () => { paints++; } }); owner.abort();
  await assert.rejects(work, { name: 'AbortError' }); cache.resolve({ schemaVersion: 1, savedAt: NOW, snapshot: body }); await Promise.resolve();
  assert.equal(fetches, 0); assert.equal(paints, 0); assert.equal(writes, 0);
  const started = Promise.withResolvers(), abort = new AbortController();
  const streaming = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); started.resolve(); } }), { headers: { 'content-type': 'application/json' } });
  const device = store(), second = createUsgsEarthquakeSource({ now: () => NOW, store: device, fetchImpl: async () => streaming });
  const reading = second.getSnapshot({ signal: abort.signal }); await started.promise; abort.abort(); await assert.rejects(reading, { name: 'AbortError' }); assert.equal(device.writes.length, 0);
});

test('expired/future/corrupt cache is ignored and a stalled cache or transport stays bounded', async () => {
  const body = await snapshot();
  for (const savedAt of [NOW + 1, NOW - EARTHQUAKE_SOURCE_LIMITS.cacheAgeMs - 1, NaN]) {
    let paints = 0; const source = createUsgsEarthquakeSource({ now: () => NOW, store: store({ schemaVersion: 1, savedAt, snapshot: body }), fetchImpl: async () => response(body) });
    await source.getSnapshot({ onCached: () => { paints++; } }); assert.equal(paints, 0);
  }
  let paints = 0, calls = 0;
  const source = createUsgsEarthquakeSource({ now: () => NOW, store: { get: () => new Promise(() => {}), put() {} },
    fetchImpl: async () => { calls++; return response(body); } });
  await source.getSnapshot({ onCached: () => { paints++; } }); assert.equal(calls, 1); assert.equal(paints, 0);
  const stuck = createUsgsEarthquakeSource({ now: () => NOW, store: store(), deadlineMs: 25, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stuck.getSnapshot(), { name: 'TimeoutError' });
});

test('recent successful source generation stays distinct from an older unchanged factual edition', async () => {
  const body = await snapshot(); body.receipt.capturedAt = iso(NOW - 3600000); body.receipt.recordedAt = iso(NOW - 3599000); body.factualEditionAgeMs = 3600000;
  body.check.sourceGeneratedAt = iso(NOW - 5000); body.sourceGenerationAgeMs = 5000;
  const normalized = await validateStoredEarthquakeSnapshot(body, { now: () => NOW });
  assert.equal(normalized.stale, false); assert.equal(normalized.factualEditionAgeMs, 3600000); assert.equal(normalized.sourceGenerationAgeMs, 5000);
  assert.notEqual(normalized.receipt.sourceUpdatedAt, normalized.check.sourceGeneratedAt);
  const empty = await validateStoredEarthquakeSnapshot(await snapshot({ mag: 2.4 }), { now: () => NOW });
  assert.deepEqual(empty.records, []); assert.equal(empty.coverage.recordCount, 0, 'a complete qualifying empty cohort is valid, not a source failure or a physical all-clear');
});
