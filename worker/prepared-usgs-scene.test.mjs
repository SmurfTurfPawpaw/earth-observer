import test from 'node:test';
import assert from 'node:assert/strict';
import { USGS_LIVE_DAY, usgsLiveDayOverview } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginJson } from '../src/core/plugin-evidence.js';
import { buildPreparedUsgsScene, selectPreparedUsgsCells, diffPreparedUsgsViews, validatePreparedUsgsScene,rebindPreparedUsgsScene, PREPARED_USGS_LIMITS } from './prepared-usgs-scene.js';

const SOURCE_AT = '2026-10-12T08:00:00.000Z', CAPTURE_AT = '2026-10-12T08:00:01.000Z', KNOWN_AT = '2026-10-12T08:00:02.000Z';
const record = (id, extra = {}) => ({ stableId: id, usgsId: id, lon: 4, lat: 50, depthKm: 12, mag: 3,
  place: null, time: Date.parse(SOURCE_AT) - 1000, sourceUrl: null, updatedAt: Date.parse(SOURCE_AT),
  eventType: 'earthquake', reviewStatus: 'reviewed', sourceTitle: null, ...extra });
async function fixture(records, fence = 1) {
  records = [...records].sort((a, b) => a.stableId.localeCompare(b.stableId));
  const facts = { schemaVersion: 1, kind: 'usgs-rolling-seismic-observations', scopeId: USGS_LIVE_DAY.scopeId,
    sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, records };
  const counts = new Map(); for (const row of records) counts.set(row.eventType, (counts.get(row.eventType) || 0) + 1);
  const overview = usgsLiveDayOverview({ canonicalFacts: facts, sourceGeneratedAt: SOURCE_AT, sourceFeatureCount: records.length,
    countsBySourceType: [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => String(a.type).localeCompare(String(b.type))) });
  const id = `receipt:${String(fence).padStart(64, '0')}`;
  return { schemaVersion: 1, configured: true, available: true, knownAt: null, version: id,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId },
    scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    receipt: { id, fence, factsDigest: await pluginFactsDigest(facts), rawSha256: 'a'.repeat(64), artifactSha256: await pluginFactsDigest(overview),
      capturedAt: CAPTURE_AT, recordedAt: KNOWN_AT, sourceUpdatedAt: SOURCE_AT },
    overview, records, coverage: { complete: true, recordCount: records.length } };
}
const whole = prepared => prepared.content.levels[0].cells.map(cell => [cell.x, cell.y]);

test('prepared content retains exact identities, source types and clocks; operational checks cannot revise the scene', async () => {
  const input = await fixture([record('a'), record('b', { eventType: 'quarry blast' })]);
  const scene = await buildPreparedUsgsScene(input);
  assert.deepEqual(scene.content.features.map(feature => feature.id), ['earthquake:a', 'earthquake:b']);
  assert.deepEqual(scene.content.features[1].record, input.records[1]);
  assert.equal(scene.source.sourceGeneratedAt, SOURCE_AT); assert.equal(scene.source.capturedAt, CAPTURE_AT); assert.equal(scene.source.recordedAt, KNOWN_AT);
  assert.equal(Object.hasOwn(scene.source, 'sceneUtc'), false);
  assert.deepEqual(await buildPreparedUsgsScene({ ...input, check: { checkedAt: '2026-10-12T09:00:00.000Z' } }), scene);
  assert.equal(Object.isFrozen(scene.content.features[0].record), true);
  assert.throws(() => { scene.content.features[0].record.lat = 0; }, TypeError);
});

test('receipt/factual/overview mismatches and later knowledge fail before any scene can be prepared', async () => {
  const input = await fixture([record('a')]);
  for (const invalid of [
    { ...input, coverage: { complete: false, recordCount: 1 } },
    { ...input, receipt: { ...input.receipt, factsDigest: 'b'.repeat(64) } },
    { ...input, overview: { ...input.overview, sourceGeneratedAt: '2026-10-12T07:00:00.000Z' } },
    { ...input, plugin: { ...input.plugin, id: 'other' } },
    { ...input, knownAt: CAPTURE_AT },
  ]) await assert.rejects(buildPreparedUsgsScene(invalid), TypeError);
  const admitted = await buildPreparedUsgsScene({ ...input, knownAt: KNOWN_AT });
  assert.equal(admitted.source.recordedAt, KNOWN_AT);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(buildPreparedUsgsScene(input, { signal: cancel.signal }), { name: 'AbortError' });
});

test('dateline/pole indexing preserves reported coordinates; cluster centers remain explicitly derived summaries', async () => {
  const scene = await buildPreparedUsgsScene(await fixture([
    record('a', { lon: -180, lat: 90, mag: 3 }), record('b', { lon: 180, lat: 90, mag: 5 }), record('c', { lon: 179.9, lat: -90 }),
  ]));
  const grid = scene.content.levels[2];
  assert.deepEqual(grid.cells.map(cell => [cell.x, cell.y]), [[0, 0], [127, 63]]);
  assert.equal(scene.content.features[1].record.lon, 180);
  const view = await selectPreparedUsgsCells(scene, { level: 2, cells: [[0, 0]], mode: 'clusters' });
  assert.equal(view.clusters[0].count, 2); assert.equal(view.clusters[0].maximumMagnitude, 5);
  assert.match(view.clusters[0].positionMeaning, /not an event epicenter/);
  assert.equal(view.features.length, 0); assert.equal(view.counts.selectedReports, 2);
  assert.notEqual(view.clusters[0].lon, -180);
});

test('canonical cell selection is complete for its scope, bounded, and never invents absent-cell reports', async () => {
  const scene = await buildPreparedUsgsScene(await fixture([record('a'), record('b', { lon: -80, lat: -30 })]));
  const cells = whole(scene), a = await selectPreparedUsgsCells(scene, { level: 0, cells, mode: 'features' });
  assert.deepEqual(await selectPreparedUsgsCells(scene, { level: 0, cells: [...cells].reverse(), mode: 'features' }), a);
  assert.equal(a.features.length, 2); assert.deepEqual(a.features.map(feature => feature.record), scene.content.features.map(feature => feature.record));
  const empty = await selectPreparedUsgsCells(scene, { level: 2, cells: [[1, 1]], mode: 'features' });
  assert.equal(empty.features.length, 0); assert.equal(empty.counts.sourceReports, 2); assert.equal(empty.coverage.selectedCellsComplete, true);
  for (const query of [{ level: 3, cells }, { level: 0, cells: [cells[0], cells[0]] }, { level: 0, cells: [[8, 0]] },
    { level: 2, cells: Array.from({ length: 129 }, (_, i) => [i % 128, 0]) }]) await assert.rejects(selectPreparedUsgsCells(scene, query), TypeError);
});

test('regional delta recreates the exact newer facts, preserves unchanged feature identity, and qualifies display removals', async () => {
  const before = await buildPreparedUsgsScene(await fixture([record('a'), record('b'), record('c')]));
  const after = await buildPreparedUsgsScene(await fixture([record('a', { mag: 4, lat: 51 }), record('c'), record('d')], 2));
  const query = { level: 0, cells: whole(before), mode: 'features' };
  const oldView = await selectPreparedUsgsCells(before, query), newView = await selectPreparedUsgsCells(after, query);
  const delta = diffPreparedUsgsViews(oldView, newView);
  assert.equal(delta.snapshotRequired, false); assert.equal(delta.baseVersion, oldView.version); assert.equal(delta.version, newView.version);
  assert.deepEqual(delta.upsertFeatures.map(feature => feature.id), ['earthquake:a', 'earthquake:d']);
  assert.deepEqual(delta.removeFeatureIds, ['earthquake:b']); assert.match(delta.removalMeaning, /no withdrawal/);
  const applied = new Map(oldView.features.map(feature => [feature.id, feature]));
  for (const id of delta.removeFeatureIds) applied.delete(id);
  for (const feature of delta.upsertFeatures) applied.set(feature.id, feature);
  assert.deepEqual([...applied.values()].sort((a, b) => a.id.localeCompare(b.id)), newView.features);
  assert.equal(applied.get('earthquake:c'), oldView.features.find(feature => feature.id === 'earthquake:c'));
  assert.equal(diffPreparedUsgsViews(newView, oldView).snapshotRequired, true);
  const different = await selectPreparedUsgsCells(after, { ...query, mode: 'clusters' });
  assert.equal(diffPreparedUsgsViews(oldView, different).snapshotRequired, true);
});

test('a large admitted cohort stays within encoded byte bounds; a new receipt shares the same factual content', async () => {
  const input = await fixture(Array.from({ length: 400 }, (_, i) => record(`r${String(i).padStart(3, '0')}`, { lon: (i * 13) % 360 - 180, lat: (i * 7) % 180 - 90 })));
  const scene = await buildPreparedUsgsScene(input);
  const other = await buildPreparedUsgsScene({ ...input, version: `receipt:${'b'.repeat(64)}`,
    receipt: { ...input.receipt, id: `receipt:${'b'.repeat(64)}`, fence: 2, recordedAt: '2026-10-12T08:00:03.000Z' } });
  assert.equal(other.contentDigest, scene.contentDigest); assert.notEqual(other.version, scene.version);
  const view = await selectPreparedUsgsCells(scene, { level: 0, cells: whole(scene), mode: 'features' });
  assert.equal(view.features.length, 400);
  assert.ok(new TextEncoder().encode(pluginJson(scene)).byteLength <= PREPARED_USGS_LIMITS.preparedBytes);
  assert.ok(new TextEncoder().encode(pluginJson(view)).byteLength <= PREPARED_USGS_LIMITS.viewBytes);
});

test('cold persisted admission verifies feature/grid integrity; same factual content can bind an exact later receipt',async()=>{
  const input=await fixture([record('a'),record('b',{lon:-150,lat:-45})]);
  const built=await buildPreparedUsgsScene(input),persisted=JSON.parse(pluginJson(built));
  const admitted=await validatePreparedUsgsScene(persisted);assert.deepEqual(admitted,built);
  const nextReceipt={...input.receipt,id:`receipt:${'c'.repeat(64)}`,fence:2,capturedAt:'2026-10-12T08:02:01.000Z',
    recordedAt:'2026-10-12T08:02:02.000Z',sourceUpdatedAt:'2026-10-12T08:02:00.000Z'};
  const rebound=await rebindPreparedUsgsScene(admitted,nextReceipt);
  assert.equal(rebound.content,admitted.content);assert.equal(rebound.source.capturedAt,nextReceipt.capturedAt);
  assert.equal(rebound.source.recordedAt,nextReceipt.recordedAt);assert.equal(rebound.source.sourceGeneratedAt,nextReceipt.sourceUpdatedAt);
  assert.equal(rebound.contentDigest,built.contentDigest);assert.notEqual(rebound.version,built.version);
  await assert.rejects(rebindPreparedUsgsScene(admitted,{...nextReceipt,factsDigest:'d'.repeat(64)}),TypeError);
  for(const change of [value=>value.content.features[0].revision='e'.repeat(64),value=>value.content.levels[1].cells[0].maximumMagnitude++,
    value=>value.source.recordedAt='2026-10-12T08:00:03.000Z']){
    const bad=JSON.parse(pluginJson(built));change(bad);await assert.rejects(validatePreparedUsgsScene(bad),TypeError);
  }
});
