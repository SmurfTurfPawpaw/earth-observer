import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPreparedSceneLayer } from './prepared-scene-layer.js';
import { createPreparedGdacsLayer } from '../layers/gdacs/prepared-layer.js';
import { createPreparedEarthquakesLayer } from '../layers/earthquakes/prepared-layer.js';
import { normalizePreparedSceneDelivery } from './regional-scene-client.js';
import { buildPreparedScene, selectPreparedScene } from '../../worker/prepared-scene-builder.js';
import { buildPreparedUsgsScene } from '../../worker/prepared-usgs-scene.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem } from './world-model.js';
import { worldHash } from './world-identity.js';
import { pluginFactsDigest, pluginBytesDigest } from './plugin-evidence.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from './usgs-live-day.js';
import { gdacsNoticeSelection } from './gdacs-dossier.js';
import { mapClusterBadge } from './map-symbols.js';

const NOW = Date.parse('2026-10-12T09:00:00.000Z'), demand = { level: 0, cells: [[4, 0]], mode: 'clusters' },
  CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK, DOUBLE = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
function nativeViewer() {
  let selected, tracked, picked; const actions = new Map(), native = [], flights = [];
  actions.set(CLICK, () => native.push('native'));
  const viewer = { scene: { primitives: new Cesium.PrimitiveCollection(), requestRender() {}, pick: () => picked },
    camera: { changed: new Cesium.Event(), moveEnd: new Cesium.Event(), flyTo: value => flights.push(value) },
    selectedEntityChanged: new Cesium.Event(), trackedEntityChanged: new Cesium.Event(), isDestroyed: () => false,
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (value, type) => actions.set(type, value), removeInputAction: type => actions.delete(type) } };
  Object.defineProperties(viewer, { selectedEntity: { get: () => selected, set(value) { if (value !== selected) { selected = value; viewer.selectedEntityChanged.raiseEvent(value); } } },
    trackedEntity: { get: () => tracked, set(value) { if (value !== tracked) { tracked = value; viewer.trackedEntityChanged.raiseEvent(value); } } } });
  return { viewer, actions, native, flights, pick(symbol, type = CLICK) { picked = symbol ? { id: symbol.id, primitive: symbol } : null;
    actions.get(type)?.({ position: { x: 4, y: 5 } }); } };
}
async function gdacsPrepared(red = true, advance = 0, mixed = false) {
  const capturedAt = new Date(NOW + advance).toISOString(), publishedAt = new Date(NOW + advance + 1000).toISOString();
  const records = [1, 2, 3].map(i => { const type = mixed ? ['FL', 'TC', 'VO'][i - 1] : 'FL';
    return canonicalDiscoveryRecord({ id: `gdacs:${type}:800${i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report',
      category: 'disasters', title: `Retained original notice ${i}`, eventType: type, url: `https://www.gdacs.org/report.aspx?eventid=800${i}&eventtype=${type}&episodeid=1`,
      lat: i === 3 && !mixed ? null : 50, lon: i === 3 && !mixed ? null : 4, alertLevel: i === 1 && red ? 'red' : 'orange',
      observedAt: new Date(NOW - 30000).toISOString(), updatedAt: new Date(NOW - 10000).toISOString(), retrievedAt: capturedAt }); });
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, bodySha256 = await worldHash(body),
    snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt: _clock, ...record }) => record) });
  const items = await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt, recordedAt: publishedAt }),
    origin: { snapshotId, firstCapturedAt: capturedAt, firstRecordedAt: publishedAt, validation: 'retained-revision-index-only', bodyValidated: false } })));
  return buildPreparedScene('gdacs', { schemaVersion: 1, configured: true, available: true, kind: 'source-item-cohort', mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt, publishedAt }), readAt: publishedAt,
    cohort: { sourceId: 'gdacs', snapshotId, bodySha256, capturedAt, publishedAt, recordCount: 3 }, items,
    counts: { returned: 3, mapped: mixed ? 3 : 2, unmapped: mixed ? 0 : 1 }, coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
      completeRetainedCohort: true, completeProviderArchive: false }, operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } }, { now: () => NOW + 60000 });
}
async function usgsPrepared(mag = 6) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl, generated: NOW - 2000, count: 1 },
    features: [{ type: 'Feature', id: 'us-mixed-1', properties: { mag, time: NOW - 30000, updated: NOW - 10000, status: 'reviewed', type: 'earthquake', place: 'Reported source place' },
      geometry: { type: 'Point', coordinates: [4, 50, 12] } }] }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${'a'.repeat(64)}`, fence: 1,
    factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview),
    capturedAt: new Date(NOW - 1000).toISOString(), recordedAt: new Date(NOW).toISOString(), sourceUpdatedAt: decoded.sourceGeneratedAt };
  const prepared = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: 1 } });
  return buildPreparedScene('earthquakes', { available: true, prepared }, { now: () => NOW });
}
async function view(prepared, at = NOW) {
  const check = prepared.sourceKey === 'gdacs' ? null : { checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + 60000).toISOString(),
    lastSuccessfulAt: new Date(NOW).toISOString(), status: 'ready', sourceGeneratedAt: prepared.source.sourceGeneratedAt };
  return normalizePreparedSceneDelivery({ schemaVersion: 1, configured: true, available: true, pending: false, policyId: prepared.policyId,
    sourceKey: prepared.sourceKey, source: prepared.source, kind: 'prepared-scene-delivery', transport: 'snapshot', snapshotRequired: false, delta: null,
    check, stale: check ? false : null, sourceGenerationAgeMs: check ? 2000 : null, scene: await selectPreparedScene(prepared, demand, { now: () => at }) },
    demand, { sourceKey: prepared.sourceKey, now: () => at });
}

test('shared native renderer preserves GDACS highlight/residual counts, unlocated metadata and exact original dossier evidence', async t => {
  const prepared = await gdacsPrepared(), current = await view(prepared), f = nativeViewer(), layer = createPreparedGdacsLayer({ client: { load: async () => current }, getDemand: () => demand });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); assert.equal(await layer.update(f.viewer), true);
  const symbols = f.viewer.scene.primitives.get(0); assert.equal(symbols.length, 2); assert.equal(f.viewer.scene.primitives.length, 1);
  assert.equal(current.scene.counts.selectedMapped, current.scene.counts.features + current.scene.counts.clusteredReports);
  const cluster = current.scene.clusters[0]; assert.equal(symbols.get(1).image, mapClusterBadge(cluster.count, 'flood').image);
  assert.equal(symbols.get(1).width, 48); assert.equal(symbols.get(1).height, 42); assert.equal(symbols.get(1).disableDepthTestDistance, undefined);
  f.pick(symbols.get(0)); const selected = f.viewer.selectedEntity, selection = gdacsNoticeSelection(selected, Cesium.JulianDate.now());
  assert.ok(selection); assert.equal(selection.notice.item.revision, current.scene.features[0].revision);
  assert.equal(selection.notice.cohort.snapshotId, prepared.source.snapshotId); assert.equal(selection.notice.item.origin.bodyValidated, false);
  assert.equal(selected.properties.sourceAssessment.getValue().reach, 'unresolved'); assert.equal(layer.getStats().status, 'unknown');
  assert.equal(layer.getStats().sourceAgeMs, null); assert.equal(layer.getStats().stale, null); assert.equal(Object.hasOwn(layer.getStats().cohort, 'fence'), false);
  assert.equal(layer.getRowControls().items.length, 3); const unmapped = current.scene.unmappedFeatures[0];
  assert.equal(layer.setParams({ inspectItem: unmapped.id }), true); assert.equal(f.viewer.selectedEntity.position, undefined);
  assert.ok(gdacsNoticeSelection(f.viewer.selectedEntity, Cesium.JulianDate.now())); assert.equal(symbols.length, 2);
  assert.deepEqual(layer.getAnalystRecords(), []); f.pick(symbols.get(1)); assert.equal(f.flights.length, 1);
});

test('two closed source wrappers delegate picks to their own shared-engine cohort and ordinary native selection', async t => {
  const f = nativeViewer(), seismic = await view(await usgsPrepared()), notices = await view(await gdacsPrepared());
  const a = createPreparedEarthquakesLayer({ client: { load: async () => seismic }, getDemand: () => demand }),
    b = createPreparedGdacsLayer({ client: { load: async () => notices }, getDemand: () => demand });
  a.init(f.viewer); a.enable(); b.init(f.viewer); b.enable(); t.after(() => { b.destroy(); a.destroy(); });
  await a.update(f.viewer); await b.update(f.viewer); const aSymbols = f.viewer.scene.primitives.get(0), bSymbols = f.viewer.scene.primitives.get(1);
  f.pick(aSymbols.get(0)); assert.equal(f.viewer.selectedEntity.id, 'earthquake:us-mixed-1'); assert.equal(f.viewer.selectedEntity.properties.sourceReceiptId.getValue(), seismic.source.receiptId);
  f.pick(bSymbols.get(0)); assert.ok(gdacsNoticeSelection(f.viewer.selectedEntity, Cesium.JulianDate.now()));
  f.viewer.earthTime = { getState: () => ({ mode: 'history' }) }; const selected = f.viewer.selectedEntity;
  assert.equal(b.setParams({ inspect: notices.scene.unmappedFeatures[0].id }), false); f.pick(aSymbols.get(0)); assert.equal(f.viewer.selectedEntity, selected);
  assert.equal(await a.update(f.viewer), false); delete f.viewer.earthTime; f.pick(null); assert.deepEqual(f.native, ['native']);
  assert.throws(() => createPreparedSceneLayer({ descriptor: { sourceKey: 'unreviewed' } }), TypeError);
});

test('source-constant interest refresh and highlight demotion retain exact selected/tracked proof; a changed factual basis without its row clears both', async t => {
  const original = await gdacsPrepared(); let current = await view(original); const f = nativeViewer(), layer = createPreparedGdacsLayer({ client: { load: async () => current }, getDemand: () => demand });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); await layer.update(f.viewer);
  const symbol = f.viewer.scene.primitives.get(0).get(0); f.pick(symbol); f.pick(symbol, DOUBLE);
  const selected = f.viewer.selectedEntity, bag = selected.properties; bag.addProperty('_testRetainedProof', { stable: true });
  current = await view(original, NOW + 60000); await layer.update(f.viewer); assert.equal(selected.properties, bag);
  current = await view(original, NOW + 3600000); assert.equal(current.scene.features.length, 0); await layer.update(f.viewer);
  assert.equal(f.viewer.selectedEntity, selected); assert.equal(f.viewer.trackedEntity, selected); assert.equal(selected.properties, bag);
  assert.equal(selected.properties.hasProperty('_testRetainedProof'), true); assert.equal(layer.getStats().count, 2);
  current = await view(await gdacsPrepared(false, 2000), NOW + 3600000); await layer.update(f.viewer);
  assert.equal(f.viewer.selectedEntity, undefined); assert.equal(f.viewer.trackedEntity, undefined);
});

test('same-cell category and source summaries use distinct bounded screen slots while exact geographic centers and counts stay unchanged', async t => {
  const f = nativeViewer(), seismic = await view(await usgsPrepared(3)), notices = await view(await gdacsPrepared(false, 0, true));
  const a = createPreparedEarthquakesLayer({ client: { load: async () => seismic }, getDemand: () => demand }),
    b = createPreparedGdacsLayer({ client: { load: async () => notices }, getDemand: () => demand });
  a.init(f.viewer); a.enable(); b.init(f.viewer); b.enable(); t.after(() => { b.destroy(); a.destroy(); }); await a.update(f.viewer); await b.update(f.viewer);
  const symbols = [f.viewer.scene.primitives.get(0).get(0), ...Array.from({ length: 3 }, (_, i) => f.viewer.scene.primitives.get(1).get(i))],
    clusters = [...seismic.scene.clusters, ...notices.scene.clusters], offsets = new Set();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i], cluster = clusters[i]; offsets.add(`${symbol.pixelOffset.x}:${symbol.pixelOffset.y}`);
    assert.ok(Math.hypot(symbol.pixelOffset.x, symbol.pixelOffset.y) <= 71);
    assert.equal(Cesium.Cartesian3.equals(symbol.position, Cesium.Cartesian3.fromDegrees(cluster.lon, cluster.lat)), true);
    assert.equal(symbol.id.id, cluster.id); assert.equal(symbol.disableDepthTestDistance, undefined);
  }
  assert.equal(offsets.size, 4); assert.equal(notices.scene.counts.clusteredReports, 3); assert.equal(a.getStats().count, 1); assert.equal(b.getStats().count, 3);
  assert.match(b.getStats().clusterLayout.meaning, /unchanged derived cell center/);
});

test('a scene byte-budget failure is unavailable rather than perpetual preparation, with the prior complete edition retained', async t => {
  const ready = await view(await gdacsPrepared()), budget = { pending: true, preparing: false, errorCode: 'scene-byte-budget' };
  let current = budget; const f = nativeViewer(), layer = createPreparedGdacsLayer({ client: { load: async () => current }, getDemand: () => demand });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); assert.equal(await layer.update(f.viewer), false);
  assert.equal(layer.getStats().pending, false); assert.equal(layer.getStats().loading, false); assert.equal(layer.getStats().status, 'unavailable');
  assert.equal(layer.getStats().sourceErrorCode, 'scene-byte-budget'); assert.equal(layer.getRowControls().info, 'Dense area requires aggregation');
  current = ready; await layer.update(f.viewer); const symbols = f.viewer.scene.primitives.get(0); f.pick(symbols.get(0)); const selected = f.viewer.selectedEntity;
  current = budget; assert.equal(await layer.update(f.viewer), false); assert.equal(f.viewer.scene.primitives.get(0), symbols);
  assert.equal(f.viewer.selectedEntity, selected); assert.equal(layer.getStats().cohort.publishedAt, ready.source.publishedAt);
  assert.equal(layer.getStats().requestedViewportComplete, false); assert.match(layer.getRowControls().info, /previous complete view retained/);
});
