import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedScenesApiHandler } from './prepared-scenes-api.js';
import { buildPreparedScene, selectPreparedScene } from './prepared-scene-builder.js';
import { buildPreparedUsgsScene } from './prepared-usgs-scene.js';
import { decodeUsgsLiveDay, usgsLiveDayOverview, USGS_LIVE_DAY } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from '../src/core/plugin-evidence.js';
import { applyPreparedSceneDelta } from '../src/core/prepared-scene-contract.js';
const CLOCK = Date.parse('2026-10-12T09:00:00.000Z'), now = () => CLOCK, AT = new Date(CLOCK).toISOString();
const selection = { level: 0, cells: [[4, 0]], mode: 'features' }, uri = '/api/layers/scenes?source=earthquakes&level=0&cells=4:0&mode=features';
async function fixture(mag = 3, fence = 1, total = 1) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: CLOCK, count: total, status: 200, url: USGS_LIVE_DAY.sourceUrl },
    features: Array.from({ length: total }, (_, i) => ({ type: 'Feature', id: `us-api-test-${i}`, geometry: { type: 'Point', coordinates: [4, 50, 12] },
      properties: { mag, place: 'TEST ONLY', time: CLOCK, updated: CLOCK, type: 'earthquake' } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence,
    factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview), capturedAt: AT, recordedAt: AT, sourceUpdatedAt: decoded.sourceGeneratedAt };
  const old = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null, plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId },
    scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 }, version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: total } });
  const prepared = await buildPreparedScene('earthquakes', { available: true, prepared: old }, { now });
  return { schemaVersion: 1, configured: true, available: true, pending: false, sourceKey: 'earthquakes', source: prepared.source,
    prepared, prior: null, check: null, stale: null, sourceGenerationAgeMs: null };
}
const request = query => new Request(`https://example.test${query}`);
test('closed bounded source query rejects foreign/duplicate/history/arbitrary selectors before reads', async () => {
  let reads = 0; const handler = createPreparedScenesApiHandler({ now, read: () => { ++reads; assert.fail('invalid query read'); } });
  for (const path of [uri + '&source=gdacs', uri.replace('earthquakes', '__proto__'), uri + '&knownAt=' + AT, uri + '&url=https://example.test',
    uri.replace('4:0', '4:0,4:0'), uri.replace('source=earthquakes', 'source=gdacs') + '&fence=1']) assert.equal((await handler(request(path), {})).status, 400);
  assert.equal((await handler(new Request('https://example.test' + uri, { method: 'POST' }), {})).status, 405);
  const controller = new AbortController(); controller.abort(); assert.equal((await handler(new Request('https://example.test' + uri, { signal: controller.signal }), {})).status, 408);
  assert.equal(reads, 0); assert.equal(await handler(request('/other'), {}), null);
});
test('stored snapshots, exact prior delta, fence waiting and pinned prior features preserve original source dates', async () => {
  const a = await fixture(), b = await fixture(4, 2); let value = a, reads = 0;
  const handler = createPreparedScenesApiHandler({ now, read: async (_env, key, options) => { assert.equal(key, 'earthquakes'); assert.ok(options.signal); ++reads; return value; } }), env = {};
  const first = await (await handler(request(uri), env)).json(); assert.equal(first.transport, 'snapshot'); value = { ...b, prior: a.prepared };
  const next = await (await handler(request(uri + '&baseVersion=' + encodeURIComponent(first.scene.version)), env)).json(); assert.equal(next.transport, 'delta');
  const applied = applyPreparedSceneDelta(first.scene, next.delta, { now }); assert.equal(applied.features[0].record.mag, 4); assert.equal(applied.source.capturedAt, AT);
  assert.equal((await handler(request(uri + '&fence=3'), env)).status, 409);
  const feature = a.prepared.content.features[0], pinned = await (await handler(request('/api/layers/scenes?' + new URLSearchParams({ source: 'earthquakes', feature: feature.id, revision: feature.revision, sourceVersion: a.source.receiptId })), env)).json();
  assert.equal(pinned.current, false); assert.equal(pinned.source.receiptId, a.source.receiptId); assert.equal(pinned.check, null); assert.equal(pinned.feature.record.mag, 3);
  assert.equal(reads, 4);
});
test('cached bases beyond current/prior fall back to snapshots and changing interest never mutates retained facts', async () => {
  const a = await fixture(), b = await fixture(4, 2), c = await fixture(5, 3); let value = a, clock = CLOCK;
  const handler = createPreparedScenesApiHandler({ now: () => clock, read: async () => value }), env = {};
  const initial = await (await handler(request(uri), env)).json(); value = { ...b, prior: a.prepared }; await handler(request(uri), env);
  value = { ...c, prior: b.prepared }; const recovered = await (await handler(request(uri + '&baseVersion=' + encodeURIComponent(initial.scene.version)), env)).json();
  assert.equal(recovered.transport, 'snapshot'); assert.equal(recovered.snapshotRequired, true); assert.equal(recovered.recoveryReason, 'base-not-retained');
  const before = c.prepared.version; clock += 60000; const later = await (await handler(request(uri), env)).json();
  assert.notEqual(later.scene.version, recovered.scene.version); assert.equal(c.prepared.version, before); assert.equal(later.source.recordedAt, AT);
});
test('pending and ignored-reader deadline fail boundedly without any build or fallback acquisition', async () => {
  const pending = createPreparedScenesApiHandler({ now, read: async () => ({ configured: true, available: false, pending: true }) });
  const response = await pending(request(uri), {}); assert.equal(response.status, 503); assert.equal((await response.json()).pending, true);
  const hung = createPreparedScenesApiHandler({ now, deadlineMs: 10, read: () => new Promise(() => {}) });
  assert.equal((await hung(request(uri), {})).status, 503);
});

test('dense 500-report detail fails explicitly at byte budget while the complete coarse summary remains available', async () => {
  const stored = await fixture(3, 1, 500), handler = createPreparedScenesApiHandler({ now, read: async () => stored }), env = {};
  const coarseResponse = await handler(request(uri.replace('mode=features', 'mode=clusters')), env);
  assert.equal(coarseResponse.status, 200); const coarse = await coarseResponse.json();
  assert.equal(coarse.scene.counts.selectedMapped, 500); assert.equal(coarse.scene.counts.clusteredReports, 500);
  const detailResponse = await handler(request(uri), env); assert.equal(detailResponse.status, 503);
  const detail = await detailResponse.json(); assert.equal(detail.errorCode, 'scene-byte-budget');
  assert.equal(detail.pending, false); assert.equal(detail.configured, true); assert.equal(detail.available, false); assert.equal(detail.scene, null);
});
