import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedUsgsApiHandler, PREPARED_USGS_API_PATH } from './prepared-usgs-api.js';
import { buildPreparedUsgsScene } from './prepared-usgs-scene.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from '../src/core/plugin-evidence.js';

const NOW = Date.parse('2026-10-12T09:00:00.000Z'), UTF8 = new TextEncoder();
const request = (query = 'level=0&cells=4:0&mode=features', options) => new Request(`https://example.test${PREPARED_USGS_API_PATH}?${query}`, options);
async function fixture(magnitude = 3, fence = 1, recordCount = 2) {
  const raw = UTF8.encode(JSON.stringify({ type: 'FeatureCollection', metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl,
    generated: NOW - 2000, count: recordCount }, features: Array.from({ length: recordCount }, (_, i) => ({ type: 'Feature', id: `us-fixture-${String(i).padStart(3, '0')}`,
      properties: { mag: magnitude, time: NOW - 4000, updated: NOW - 3000, type: i === 1 ? 'quarry blast' : 'earthquake', status: 'reviewed' },
      geometry: { type: 'Point', coordinates: [4, 50, 12] } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), overview = usgsLiveDayOverview(decoded);
  const receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence, factsDigest: await pluginFactsDigest(decoded.canonicalFacts),
    rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview),
    capturedAt: new Date(NOW - 1000).toISOString(), recordedAt: new Date(NOW).toISOString(), sourceUpdatedAt: decoded.sourceGeneratedAt };
  const prepared = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId },
    scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount } });
  return { schemaVersion: 1, configured: true, available: true, pending: false, policyId: prepared.content.policyId,
    source: prepared.source, check: { checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + 60000).toISOString(),
      lastSuccessfulAt: new Date(NOW).toISOString(), status: 'ready', sourceGeneratedAt: new Date(NOW - 2000).toISOString() },
    stale: false, sourceGenerationAgeMs: 2000, prepared, prior: null };
}

test('strict region/pinned query and method admission rejects malformed or foreign fields before any stored read', async () => {
  let reads = 0; const handler = createPreparedUsgsApiHandler({ read: () => { reads++; throw Error('Must not read'); } });
  for (const query of ['level=0', 'cells=4:0', 'level=3&cells=4:0', 'level=00&cells=4:0', 'level=0&cells=8:0',
    'level=0&cells=4:0,4:0', 'level=0&cells=4:1,4:0', 'level=0&cells=04:0', 'level=0&cells=4:0&knownAt=2026-10-12T09:00:00.000Z',
    'level=0&cells=4:0&level=0', 'level=0&cells=4:0&mode=heatmap', 'level=0&cells=4:0&baseVersion=old',
    'level=0&cells=4:0&fence=0', 'level=0&cells=4:0&fence=9007199254740992',
    'feature=earthquake:us-fixture-000&revision=' + 'a'.repeat(64), 'level=0&cells=' + '0:0,'.repeat(500)]) {
    assert.equal((await handler(request(query), {})).status, 400, query);
  }
  for (const method of ['POST', 'PUT', 'HEAD']) {
    const result = await handler(request(undefined, { method }), {}); assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'GET');
  }
  assert.equal(await handler(new Request('https://example.test/api/other'), {}), null); assert.equal(reads, 0);
});

test('regional snapshots preserve exact source type/basis while operational checks and view cache remain separate', async () => {
  let value = await fixture(), reads = 0; const env = {};
  const handler = createPreparedUsgsApiHandler({ read: async (_env, options) => { reads++; assert.equal(options.includePrior, false); return value; } });
  const first = await handler(request(), env), initial = await first.json();
  assert.equal(first.status, 200); assert.equal(first.headers.get('x-earth-view-cache'), 'MISS');
  assert.equal(initial.transport, 'snapshot'); assert.equal(initial.scene.features.length, 2);
  assert.equal(initial.scene.features[1].record.eventType, 'quarry blast');
  assert.deepEqual(initial.source, value.source); assert.deepEqual(initial.scene.source, value.source);
  const changedCheck = { ...value.check, checkedAt: new Date(NOW + 60000).toISOString() };
  value = { ...value, check: changedCheck, sourceGenerationAgeMs: 62000 };
  const second = await handler(request(), env), checked = await second.json();
  assert.equal(second.headers.get('x-earth-view-cache'), 'HIT'); assert.deepEqual(checked.scene, initial.scene);
  assert.deepEqual(checked.check, changedCheck); assert.equal(checked.sourceGenerationAgeMs, 62000);
  assert.equal(checked.source.capturedAt, initial.source.capturedAt); assert.equal(reads, 2);
  const empty = await (await handler(request('level=0&cells='), env)).json();
  assert.equal(empty.scene.counts.selectedReports, 0); assert.equal(empty.scene.features.length, 0);
});

test('exact server-retained delta bases recover A/B/A, unknown bases and changed viewport use complete snapshots', async () => {
  const a = await fixture(3, 1), b = await fixture(4, 2), again = await fixture(3, 3); let value = a;
  const handler = createPreparedUsgsApiHandler({ read: async (_env, { includePrior }) => ({ ...value, prior: includePrior ? value.prior : null }) }), env = {};
  const aView = (await (await handler(request(), env)).json()).scene;
  value = { ...b, prior: a.prepared };
  const bDelta = await (await handler(request(`level=0&cells=4:0&mode=features&baseVersion=${aView.version}`), env)).json();
  assert.equal(bDelta.transport, 'delta'); assert.equal(bDelta.scene, null); assert.equal(bDelta.delta.baseVersion, aView.version);
  assert.equal(bDelta.delta.upsertFeatures[0].record.mag, 4); assert.deepEqual(bDelta.delta.source, b.source);
  const bView = (await (await handler(request(), env)).json()).scene;
  value = { ...again, prior: b.prepared };
  const reverted = await (await handler(request(`level=0&cells=4:0&mode=features&baseVersion=${bView.version}`), env)).json();
  assert.equal(reverted.delta.upsertFeatures[0].record.mag, 3); assert.notEqual(reverted.delta.version, aView.version);
  const latest = (await (await handler(request(), env)).json()).scene;
  const applied = new Map(bView.features.map(feature => [feature.id, feature]));
  for (const id of reverted.delta.removeFeatureIds) applied.delete(id);
  for (const feature of reverted.delta.upsertFeatures) applied.set(feature.id, feature);
  assert.deepEqual([...applied.values()], latest.features); assert.equal(reverted.delta.version, latest.version);
  for (const suffix of [`baseVersion=view:${'f'.repeat(64)}`, `cells=4:1&baseVersion=${bView.version}`]) {
    const query = suffix.startsWith('cells=') ? `level=0&mode=features&${suffix}` : `level=0&cells=4:0&mode=features&${suffix}`;
    const recovered = await (await handler(request(query), env)).json();
    assert.equal(recovered.transport, 'snapshot'); assert.equal(recovered.snapshotRequired, true); assert.equal(recovered.delta, null);
  }
});

test('newer SSE fence cannot admit an older prepared scene; a newer completed head may supersede the requested fence', async () => {
  const value = await fixture(3, 2), handler = createPreparedUsgsApiHandler({ read: async () => value });
  const waiting = await handler(request('level=0&cells=4:0&fence=3'), {}), pending = await waiting.json();
  assert.equal(waiting.status, 409); assert.equal(pending.available, false); assert.equal(pending.pending, true);
  assert.equal(pending.scene, null); assert.equal(pending.delta, null); assert.equal(pending.errorCode, 'source-fence-not-ready');
  const ready = await handler(request('level=0&cells=4:0&fence=1'), {}); assert.equal(ready.status, 200);
  assert.equal((await ready.json()).source.fence, 2);
});

test('pinned feature detail uses exact current/prior receipt and row revision without borrowing current operational dates', async () => {
  const a = await fixture(3, 1), b = await fixture(4, 2), value = { ...b, prior: a.prepared };
  const handler = createPreparedUsgsApiHandler({ read: async (_env, options) => { assert.equal(options.includePrior, true); return value; } });
  const feature = a.prepared.content.features[0], query = `feature=${feature.id}&revision=${feature.revision}&receipt=${a.source.receiptId}`;
  const result = await handler(request(query), {}), older = await result.json();
  assert.equal(result.status, 200); assert.equal(older.current, false); assert.deepEqual(older.feature, feature);
  assert.deepEqual(older.source, a.source); assert.equal(older.check, null); assert.equal(older.stale, null); assert.equal(older.sourceGenerationAgeMs, null);
  const mismatch = await handler(request(query.replace(feature.revision, 'f'.repeat(64))), {}); assert.equal(mismatch.status, 409);
  const foreign = await handler(request(query + '&knownAt=2026-10-12T09:00:00.000Z'), {}); assert.equal(foreign.status, 400);
});

test('missing/unconfigured stored scenes report pending/unavailable without invoking any builder or provider', async () => {
  const defaultHandler = createPreparedUsgsApiHandler(); assert.equal((await defaultHandler(request(), {})).status, 503);
  const value = await fixture(); let calls = 0;
  const handler = createPreparedUsgsApiHandler({ read: async () => { calls++; return { ...value, available: false, pending: true, prepared: null }; } });
  const result = await handler(request(), {}), body = await result.json();
  assert.equal(result.status, 503); assert.equal(body.pending, true); assert.equal(body.scene, null);
  assert.equal(result.headers.get('retry-after'), '2'); assert.equal(calls, 1);
});

test('request cancellation and deadline stop delivery and prevent late reads from populating a regional cache', async () => {
  const value = await fixture(), gate = Promise.withResolvers(), entered = Promise.withResolvers(), controller = new AbortController();
  let calls = 0, receivedSignal;
  const handler = createPreparedUsgsApiHandler({ read: (_env, { signal }) => { receivedSignal = signal; calls++; entered.resolve(); return calls === 1 ? gate.promise : Promise.resolve(value); } }), env = {};
  const pending = handler(request(undefined, { signal: controller.signal }), env);
  await entered.promise; controller.abort(); assert.equal((await pending).status, 408); assert.equal(receivedSignal.aborted, true);
  gate.resolve(value); await Promise.resolve();
  const fresh = await handler(request(), env); assert.equal(fresh.status, 200); assert.equal(fresh.headers.get('x-earth-view-cache'), 'MISS');
  const canceled = new AbortController(); canceled.abort();
  assert.equal((await handler(request(undefined, { signal: canceled.signal }), env)).status, 408); assert.equal(calls, 2);
  const deadline = createPreparedUsgsApiHandler({ deadlineMs: 10, read: () => new Promise(() => {}) });
  const expired = await deadline(request(), {}); assert.equal(expired.status, 503); assert.equal((await expired.json()).errorCode, 'scene-deadline');
});

test('completed view cache stays bounded under concurrent cold requests and distinct viewport selections', async () => {
  const value = await fixture(), env = {}, handler = createPreparedUsgsApiHandler({ read: async () => value });
  const concurrent = await Promise.all(Array.from({ length: 40 }, () => handler(request(), env)));
  assert.equal(concurrent.every(response => response.status === 200), true);
  assert.equal((await handler(request(), env)).headers.get('x-earth-view-cache'), 'HIT');
  for (let x = 0; x < 33; x++) assert.equal((await handler(request(`level=2&cells=${x}:0`), env)).status, 200);
  assert.equal((await handler(request('level=2&cells=0:0'), env)).headers.get('x-earth-view-cache'), 'MISS');
});

test('internal corruption/errors fail as unavailable with bounded sanitized output, not visitor query errors', async () => {
  const handler = createPreparedUsgsApiHandler({ read: async () => { throw new TypeError('private upstream diagnostic must not escape'); } });
  const result = await handler(request(), {}), body = await result.text();
  assert.equal(result.status, 503); assert.equal(body.includes('private upstream'), false); assert.equal(result.headers.get('cache-control'), 'no-store');
});
