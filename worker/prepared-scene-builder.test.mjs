import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreparedScene, validateStoredPreparedScene, selectPreparedScene, diffPreparedScenes } from './prepared-scene-builder.js';
import { buildPreparedUsgsScene } from './prepared-usgs-scene.js';
import { decodeUsgsLiveDay, usgsLiveDayOverview, USGS_LIVE_DAY } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest, pluginJson } from '../src/core/plugin-evidence.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createWorldSourceItem } from '../src/core/world-model.js';
import { worldHash } from '../src/core/world-identity.js';
import { applyPreparedSceneDelta, validatePreparedRegionalScene } from '../src/core/prepared-scene-contract.js';
const CLOCK = Date.parse('2026-10-12T09:00:00.000Z'), AT = new Date(CLOCK).toISOString(), now = () => CLOCK;
async function usgs(total = 20, fence = 1, mag = 6) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: CLOCK - 1000, count: total, status: 200, url: USGS_LIVE_DAY.sourceUrl },
    features: Array.from({ length: total }, (_, i) => ({ type: 'Feature', id: `us-scene-${i}`, geometry: { type: 'Point', coordinates: [i ? 179 : -180, 90, 12] },
      properties: { mag, place: 'TEST ONLY', time: CLOCK - 600000, updated: CLOCK - 1000, type: 'earthquake', status: 'reviewed' } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence,
    factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview),
    capturedAt: AT, recordedAt: AT, sourceUpdatedAt: decoded.sourceGeneratedAt };
  return { available: true, prepared: await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: total } }) };
}
async function gdacs() {
  const records = [0, 1].map(i => canonicalDiscoveryRecord({ id: `gdacs:FL:${1000 + i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report',
    category: 'disasters', title: 'TEST ONLY flood', eventType: 'FL', alertLevel: 'Red',
    url: `https://www.gdacs.org/report.aspx?eventid=${1000 + i}&episodeid=1&eventtype=FL`,
    ...(i ? {} : { lon: 4, lat: 50 }), observedAt: AT, updatedAt: AT, retrievedAt: AT }));
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt, ...record }) => record) });
  const items = await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt: AT, recordedAt: AT }),
    origin: { snapshotId, firstCapturedAt: AT, firstRecordedAt: AT, validation: 'retained-revision-index-only', bodyValidated: false } })));
  return { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: AT }), readAt: AT,
    cohort: { sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: AT, bodySha256: await worldHash(body), recordCount: 2 },
    items, counts: { returned: 2, mapped: 1, unmapped: 1 }, coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
      completeRetainedCohort: true, completeProviderArchive: false }, operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
}
const world = { level: 0, cells: Array.from({ length: 32 }, (_, i) => [i % 8, Math.floor(i / 8)]), mode: 'clusters' };
test('source-attention highlights partition the residual clusters, overflow remains counted, and fact revisions survive interest expiry', async () => {
  const prepared = await buildPreparedScene('earthquakes', await usgs(), { now });
  const fresh = await selectPreparedScene(prepared, world, { now });
  assert.equal(fresh.features.length, 16); assert.equal(fresh.counts.clusteredReports, 4); assert.equal(fresh.counts.selectedMapped, 20);
  assert.equal(fresh.clusters.reduce((sum, cell) => sum + cell.count, 0) + fresh.features.length, 20);
  assert.equal(fresh.interest.reach, 'unresolved'); assert.equal(fresh.features[0].geometry.positionMeaning, 'source-reported-seismic-location');
  const expired = await selectPreparedScene(prepared, world, { now: () => CLOCK + 3600000 });
  assert.equal(expired.features.length, 0); assert.equal(expired.counts.clusteredReports, 20); assert.notEqual(expired.version, fresh.version);
  const delta = diffPreparedScenes(fresh, expired), applied = applyPreparedSceneDelta(fresh, delta, { now: () => CLOCK + 3600000 });
  assert.deepEqual(applied.counts, expired.counts); assert.deepEqual(applied.features, expired.features); assert.deepEqual(applied.source, fresh.source);
  const local = await selectPreparedScene(prepared, { ...world, mode: 'features' }, { now }); assert.equal(local.features.length, 20);
  assert.equal(local.counts.highlights, 16); assert.equal(local.clusters.length, 0);
  const original = new Map(prepared.content.features.map(feature => [feature.id, feature.revision]));
  assert.ok(local.features.every(feature => original.get(feature.id) === feature.revision));
});
test('GDACS unlocated notices remain metadata with original evidence and source assessments, not invented map coordinates', async () => {
  const input = await gdacs(), prepared = await buildPreparedScene('gdacs', input, { now });
  const cold = await validateStoredPreparedScene(JSON.parse(pluginJson(prepared)), { now }); assert.equal(cold.source.version, input.version);
  assert.equal(Object.hasOwn(cold.source, 'fence'), false); const view = await selectPreparedScene(cold, world, { now });
  assert.equal(view.counts.sourceTotal, 2); assert.equal(view.counts.mappedTotal, 1); assert.equal(view.counts.unmappedTotal, 1);
  assert.equal(view.features.length, 1); assert.equal(view.unmappedFeatures.length, 1); assert.equal(view.unmappedFeatures[0].geometry, null);
  assert.equal(view.features[0].sourceAssessment.level, 'Red'); assert.equal(view.features[0].sourceAssessment.reach, 'unresolved');
  assert.equal(view.features[0].provenance.evidence.snapshotId, input.cohort.snapshotId);
  const wrong = structuredClone(view); wrong.features[0].provenance.evidence.snapshotId = 'f'.repeat(64); assert.throws(() => validatePreparedRegionalScene(wrong, { now }));
});
test('cold integrity rejects modified facts/grid/evidence and same-version deltas cannot mutate complete scenes', async () => {
  const prepared = await buildPreparedScene('earthquakes', await usgs(2, 1, 3), { now });
  for (const change of [value => { value.content.features[0].record.mag = 4; }, value => { value.content.levels[0].cells[0].indices = []; },
    value => { value.source.receiptId = `receipt:${'f'.repeat(64)}`; }]) {
    const bad = structuredClone(prepared); change(bad); await assert.rejects(validateStoredPreparedScene(bad, { now }));
  }
  const view = await selectPreparedScene(prepared, world, { now }), delta = diffPreparedScenes(view, view);
  assert.equal(applyPreparedSceneDelta(view, delta, { now }).version, view.version);
  const bad = { ...delta, upsertClusters: [{ ...view.clusters[0], count: 2 }] }; assert.throws(() => applyPreparedSceneDelta(view, bad, { now }));
});

test('500 retained source rows remain bounded and complete in world summaries; an oversized detail edition fails without truncation', async () => {
  const prepared = await buildPreparedScene('earthquakes', await usgs(500, 1, 3), { now });
  const storedBytes = new TextEncoder().encode(pluginJson(prepared)).length;
  assert.ok(storedBytes <= 384 * 1024); assert.equal(prepared.content.features.length, 500);
  await validateStoredPreparedScene(JSON.parse(pluginJson(prepared)), { now });
  const summary = await selectPreparedScene(prepared, world, { now }); assert.equal(summary.counts.selectedMapped, 500);
  assert.equal(summary.counts.clusteredReports, 500); assert.equal(summary.features.length, 0);
  assert.ok(new TextEncoder().encode(pluginJson(summary)).length <= 250 * 1024);
  let detailedBytes = null, detailEnvelopeBytes = null, detailRejected = false;
  try { const detailed = await selectPreparedScene(prepared, { ...world, mode: 'features' }, { now });
    detailedBytes = new TextEncoder().encode(pluginJson(detailed)).length; assert.equal(detailed.features.length, 500); assert.equal(detailed.counts.selectedMapped, 500); }
  catch (error) { assert.ok(error instanceof RangeError); detailRejected = true;
    const selection = { ...world, mode: 'features' }, selectionKey = await pluginFactsDigest(selection);
    const exactRejectedView = { ...summary, selection, selectionKey,
      version: `view:${await pluginFactsDigest([prepared.version, selectionKey, summary.interest])}`,
      features: [...prepared.content.features].sort((a, b) => a.id.localeCompare(b.id)), clusters: [],
      counts: { ...summary.counts, features: 500, clusters: 0, clusteredReports: 0 } };
    validatePreparedRegionalScene(exactRejectedView, { now }); detailedBytes = new TextEncoder().encode(pluginJson(exactRejectedView)).length;
    detailEnvelopeBytes = new TextEncoder().encode(pluginJson({ schemaVersion: 1, policyId: exactRejectedView.policyId, sourceKey: 'earthquakes', configured: true,
      available: true, pending: false, source: prepared.source, check: null, stale: null, sourceGenerationAgeMs: null,
      kind: 'prepared-scene-delivery', transport: 'snapshot', snapshotRequired: false, scene: exactRejectedView, delta: null })).length;
  }
  assert.ok(detailRejected ? detailedBytes > 250 * 1024 : detailedBytes <= 250 * 1024);
  // This is measured CPU/serialized-byte admission, not a native GPU benchmark.
  console.log(JSON.stringify({ fixture: '500 source rows', storedBytes, summaryBytes: new TextEncoder().encode(pluginJson(summary)).length,
    detailRejected, detailedBytes, detailEnvelopeBytes }));
});
