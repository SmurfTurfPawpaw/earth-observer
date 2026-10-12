import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPreparedSceneLayer, warmPreparedBillboards } from './prepared-scene-layer.js';
import { createPreparedGdacsLayer } from '../layers/gdacs/prepared-layer.js';
import { createPreparedEarthquakesLayer } from '../layers/earthquakes/prepared-layer.js';
import { normalizePreparedSceneDelivery, createRegionalSceneClient } from './regional-scene-client.js';
import { buildPreparedScene, selectPreparedScene } from '../../worker/prepared-scene-builder.js';
import { buildPreparedUsgsScene } from '../../worker/prepared-usgs-scene.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem } from './world-model.js';
import { worldHash } from './world-identity.js';
import { pluginFactsDigest, pluginBytesDigest } from './plugin-evidence.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from './usgs-live-day.js';
import { gdacsNoticeSelection } from './gdacs-dossier.js';
import { FOCUS_SCENE_POLICY, focusCellAt } from './focus-scene-contract.js';
import { selectFocusScene, focusClusterMembers } from '../../worker/focus-scene-builder.js';
import { createFocusScenesApiHandler } from '../../worker/focus-scenes-api.js';
import { createPreparedScenesApiHandler } from '../../worker/prepared-scenes-api.js';

const NOW = Date.parse('2026-10-12T09:00:00.000Z'), demand = { level: 0, cells: [[4, 0]], mode: 'clusters' },
  CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK, DOUBLE = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
// Cesium Color material's native uniform discriminator references browser constructors.
for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) globalThis[name] ||= class {};
const symbolsAt = (viewer, index = 0) => Array.from({ length: viewer.scene.primitives.length }, (_, i) => viewer.scene.primitives.get(i))
  .filter(value => value instanceof Cesium.BillboardCollection)[index];
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
async function usgsPrepared(mag = 6, fence = 1) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl, generated: NOW - 2000, count: 1 },
    features: [{ type: 'Feature', id: 'us-mixed-1', properties: { mag, time: NOW - 30000, updated: NOW - 10000, status: 'reviewed', type: 'earthquake', place: 'Reported source place' },
      geometry: { type: 'Point', coordinates: [4, 50, 12] } }] }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence,
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
  const symbols = symbolsAt(f.viewer); assert.equal(symbols.length, 4); assert.equal(f.viewer.scene.primitives.length, 2);
  assert.equal(current.scene.counts.selectedMapped, current.scene.counts.features + current.scene.counts.clusteredReports);
  assert.equal(symbols.get(2).image, 'beacon-v1-head:flood');
  assert.equal(symbols.get(2).width, 24); assert.equal(symbols.get(2).height, 24); assert.equal(symbols.get(2).disableDepthTestDistance, undefined);
  f.pick(symbols.get(0)); const selected = f.viewer.selectedEntity, selection = gdacsNoticeSelection(selected, Cesium.JulianDate.now());
  assert.ok(selection); assert.equal(selection.notice.item.revision, current.scene.features[0].revision);
  assert.equal(selection.notice.cohort.snapshotId, prepared.source.snapshotId); assert.equal(selection.notice.item.origin.bodyValidated, false);
  assert.equal(selected.properties.sourceAssessment.getValue().reach, 'unresolved'); assert.equal(layer.getStats().status, 'unknown');
  assert.equal(layer.getStats().sourceAgeMs, null); assert.equal(layer.getStats().stale, null); assert.equal(Object.hasOwn(layer.getStats().cohort, 'fence'), false);
  assert.equal(layer.getRowControls().items.length, 3); const unmapped = current.scene.unmappedFeatures[0];
  assert.equal(layer.setParams({ inspectItem: unmapped.id }), true); assert.equal(f.viewer.selectedEntity.position, undefined);
  assert.ok(gdacsNoticeSelection(f.viewer.selectedEntity, Cesium.JulianDate.now())); assert.equal(symbols.length, 4);
  assert.deepEqual(layer.getAnalystRecords(), []); f.pick(symbols.get(2)); assert.equal(f.flights.length, 1);
});

test('two closed source wrappers delegate picks to their own shared-engine cohort and ordinary native selection', async t => {
  const f = nativeViewer(), seismic = await view(await usgsPrepared()), notices = await view(await gdacsPrepared());
  const a = createPreparedEarthquakesLayer({ client: { load: async () => seismic }, getDemand: () => demand }),
    b = createPreparedGdacsLayer({ client: { load: async () => notices }, getDemand: () => demand });
  a.init(f.viewer); a.enable(); b.init(f.viewer); b.enable(); t.after(() => { b.destroy(); a.destroy(); });
  await a.update(f.viewer); await b.update(f.viewer); const aSymbols = symbolsAt(f.viewer), bSymbols = symbolsAt(f.viewer, 1);
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

test('one area symbol per source cell preserves every category count and a chooser creates a fresh exact category context after parent close', async t => {
  const prepared = await gdacsPrepared(false, 0, true), f = nativeViewer(), seismic = await focusView(await usgsPrepared(3)), notices = await focusView(prepared);
  let context, memberReads = 0;
  const a = createPreparedEarthquakesLayer({ client: { load: async () => seismic }, getDemand: () => demand }),
    b = createPreparedGdacsLayer({ client: { load: async () => notices, getMembers: async (captured, cluster) => {
      ++memberReads; return { members: focusClusterMembers(prepared, captured.scene, cluster.id), count: cluster.count, nextCursor: null,
        source: captured.source, clusterId: cluster.id, viewVersion: captured.scene.version };
    } }, getDemand: () => focused });
  b.setClusterInspectionListener(value => { context = value; });
  a.init(f.viewer); a.enable(); b.init(f.viewer); b.enable(); t.after(() => { b.destroy(); a.destroy(); }); await a.update(f.viewer); await b.update(f.viewer);
  const symbols = symbolsAt(f.viewer, 1); assert.equal(symbols.length, 2); assert.equal(notices.scene.counts.clusteredReports, 3);
  assert.equal(symbols.get(0).image, 'beacon-v1-head:notice'); assert.equal(symbols.get(0).pixelOffset.x, 0);
  const cluster = notices.scene.clusters[0], base = symbols.get(1), stem = f.viewer.scene.primitives.get(3).get(0);
  assert.equal(Cesium.Cartesian3.equals(base.position, Cesium.Cartesian3.fromDegrees(cluster.lon, cluster.lat)), true);
  assert.equal(Cesium.Cartesian3.equals(stem.positions[0], base.position), true); assert.equal(stem.id, base.id);
  assert.equal(Cesium.Cartesian3.equals(stem.positions[1], symbols.get(0).position), true);
  assert.equal(a.getStats().count, 1); assert.equal(b.getStats().count, 3); assert.equal(b.getRowControls().items.length, 3);
  assert.equal(b.setParams({ inspectMembers: symbols.get(0).id.id }), true); assert.equal(context.groups.length, 3); assert.equal(memberReads, 0);
  const chooser = context, group = chooser.groups[0]; chooser.onClose(); assert.equal(chooser.signal.aborted, true);
  assert.equal(chooser.inspectGroup(group.id), true); assert.equal(context.groups, undefined); assert.equal(context.signal.aborted, false);
  const page = await context.loadPage(); assert.equal(page.count, group.count); assert.equal(memberReads, 1);
  assert.equal(context.clusterId, undefined); assert.equal(page.clusterId, group.id);
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

const focused = { schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves: [[0, 4, 0]], focus: [0, 4, 0], featureBudget: 0 };
async function focusView(prepared, selection = focused, at = NOW) {
  const check = prepared.sourceKey === 'gdacs' ? null : { checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + 60000).toISOString(),
    lastSuccessfulAt: new Date(NOW).toISOString(), status: 'ready', sourceGeneratedAt: prepared.source.sourceGeneratedAt };
  return normalizePreparedSceneDelivery({ schemaVersion: 2, configured: true, available: true, pending: false, policyId: FOCUS_SCENE_POLICY,
    sourceKey: prepared.sourceKey, source: prepared.source, kind: 'focus-scene-delivery', transport: 'snapshot', snapshotRequired: false, delta: null,
    check, stale: check ? false : null, sourceGenerationAgeMs: check ? 2000 : null, scene: await selectFocusScene(prepared, selection, { now: () => at }) },
    selection, { sourceKey: prepared.sourceKey, now: () => at });
}
test('compact display materializes exact source evidence only after the pinned full proof and preserves it across interest-only demotion', async t => {
  const prepared = await gdacsPrepared(), first = await focusView(prepared), f = nativeViewer(), gate = Promise.withResolvers();
  let current = first, proofRequests = 0; const opened = [];
  const layer = createPreparedGdacsLayer({ getDemand: () => focused, client: { load: async () => current,
    getFeature: async compact => { proofRequests++; await gate.promise; return { source: prepared.source, feature: prepared.content.features.find(item => item.id === compact.id) }; } } });
  layer.setFeatureInspectionListener(entity => { assert.equal(f.viewer.selectedEntity, entity); opened.push(entity); });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); await layer.update(f.viewer);
  assert.equal(proofRequests, 0); assert.equal(f.viewer.selectedEntity, undefined); assert.equal(symbolsAt(f.viewer).length, 4);
  const selecting = layer.setParams({ inspect: first.scene.features[0].id }); assert.ok(selecting instanceof Promise);
  assert.equal(proofRequests, 1); assert.equal(f.viewer.selectedEntity, undefined, 'compact fields alone do not create dossier proof');
  gate.resolve(); assert.equal(await selecting, true); const selected = f.viewer.selectedEntity, bag = selected.properties;
  assert.deepEqual(opened, [selected]);
  assert.ok(gdacsNoticeSelection(selected, Cesium.JulianDate.now()));
  assert.equal(selected.properties._gdacsNotice.getValue().item.record.title, prepared.content.features[0].record.title);
  current = await focusView(prepared, focused, NOW + 3600000); await layer.update(f.viewer);
  assert.equal(current.scene.features.length, 0); assert.equal(f.viewer.selectedEntity, selected); assert.equal(selected.properties, bag);
  assert.equal(opened.length, 1, 'background display refresh does not focus the dossier again');
  current = await focusView(await gdacsPrepared(false, 2000), focused, NOW + 3600000); await layer.update(f.viewer);
  assert.equal(f.viewer.selectedEntity, undefined, 'a changed factual source cannot retain unverified compact proof');
});

test('settled same-selection camera scaling uses shared preparation without a source GET or source-position change', async t => {
  const current = await view(await usgsPrepared()), f = nativeViewer(); let pixelMetres = 10, acquisitions = 0;
  f.viewer.scene.drawingBufferWidth = 1280; f.viewer.scene.drawingBufferHeight = 720;
  f.viewer.camera.getPixelSize = () => pixelMetres;
  const layer = createPreparedEarthquakesLayer({ getDemand: () => demand, debounceMs: 150, client: { load: async () => { ++acquisitions; return current; } } });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); await layer.update(f.viewer);
  const symbols = symbolsAt(f.viewer), base = Cesium.Cartesian3.clone(symbols.get(1).position), head = Cesium.Cartesian3.clone(symbols.get(0).position);
  pixelMetres = 100; f.viewer.camera.moveEnd.raiseEvent();
  await new Promise(resolve => setTimeout(resolve, 190));
  assert.equal(acquisitions, 1); assert.equal(symbolsAt(f.viewer), symbols);
  assert.equal(Cesium.Cartesian3.equals(base, symbols.get(1).position), true); assert.equal(Cesium.Cartesian3.equals(head, symbols.get(0).position), false);
  assert.equal(layer.getStats().receipt.id, current.source.receiptId); assert.equal(layer.getStats().requestedViewportComplete, true);
});

test('a repeated cluster across different complete demand editions opens retained members instead of cycling the same zoom', async t => {
  const prepared = await gdacsPrepared(false), selectionA = { ...focused, featureBudget: 0 },
    selectionB = { ...focused, leaves: [[1, 8, 0], [1, 8, 1]], focus: [1, 8, 1], featureBudget: 0 };
  let selection = selectionA, current = await focusView(prepared, selection), context;
  const f = nativeViewer(), layer = createPreparedGdacsLayer({ getDemand: () => selection,
    client: { load: async () => current, getMembers() {} } });
  layer.setClusterInspectionListener(value => { context = value; }); layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy());
  await layer.update(f.viewer); const firstId = current.scene.clusters[0].id;
  layer.setParams({ inspect: firstId }); layer.setParams({ inspect: firstId }); assert.equal(context, undefined); assert.equal(f.flights.length, 2);
  selection = selectionB; current = await focusView(prepared, selection); await layer.update(f.viewer); layer.setParams({ inspect: current.scene.clusters[0].id });
  selection = selectionA; current = await focusView(prepared, selection); await layer.update(f.viewer);
  assert.equal(layer.setParams({ inspect: firstId }), true); assert.ok(context); assert.equal(context.cluster.id, firstId); assert.equal(f.flights.length, 3);
});

test('native warm fence keeps the prior complete source visible until public billboard readiness and disposes its bounded listeners on cancellation/timeout', async t => {
  let current = await view(await usgsPrepared(3)); const f = nativeViewer(), layer = createPreparedEarthquakesLayer({ getDemand: () => demand, client: { load: async () => current } });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); await layer.update(f.viewer);
  const prior = symbolsAt(f.viewer), priorReceipt = layer.getStats().receipt.id, waiting = Promise.withResolvers();
  f.viewer.scene.postRender = new Cesium.Event(); f.viewer.scene.requestRender = () => waiting.resolve();
  const corrected = await usgsPrepared(4, 2);
  current = await view(corrected); const pending = layer.update(f.viewer); await waiting.promise;
  const staged = symbolsAt(f.viewer, 1); assert.ok(staged); assert.equal(staged.show, true); assert.equal(prior.show, true);
  assert.equal(layer.getStats().receipt.id, priorReceipt); assert.equal(f.viewer.scene.primitives.get(3).show, false);
  for (let i = 0; i < staged.length; i++) { assert.equal(staged.get(i).show, false);
    Object.defineProperty(staged.get(i), 'ready', { value: true, configurable: true }); }
  f.viewer.scene.postRender.raiseEvent(); assert.equal(await pending, true); assert.equal(prior.isDestroyed(), true);
  assert.equal(layer.getStats().receipt.fence, 2); assert.equal(layer.getStats().editionMetrics.symbolReadiness.ready, true);
  assert.equal(f.viewer.scene.postRender.numberOfListeners, 0); assert.equal(symbolsAt(f.viewer).get(0).show, true);
  const collection = new Cesium.BillboardCollection(); collection.add({ image: 'unused-test-image' }); t.after(() => collection.destroy());
  const canceled = new AbortController(), warming = warmPreparedBillboards({ viewer: f.viewer, collection, signal: canceled.signal });
  canceled.abort(new DOMException('Test cancellation', 'AbortError')); await assert.rejects(warming, { name: 'AbortError' });
  assert.equal(f.viewer.scene.postRender.numberOfListeners, 0);
  await assert.rejects(warmPreparedBillboards({ viewer: f.viewer, collection, deadlineMs: 5 }), { code: 'symbol-readiness-timeout' });
  assert.equal(f.viewer.scene.postRender.numberOfListeners, 0); assert.equal(collection.get(0).show, false);
});

test('max-depth residuals and explicit inspection open exact member pages; picking a member proves its original and hidden work cannot select late', async t => {
  const prepared = await gdacsPrepared(), leaf = focusCellAt({ lon: 4, lat: 50 }, 18), selection = { ...focused, leaves: [leaf], focus: leaf },
    current = await focusView(prepared, selection), stored = { configured: true, available: true, pending: false, prepared, source: prepared.source,
      prior: null, check: null, stale: null, sourceGenerationAgeMs: null };
  const focus = createFocusScenesApiHandler({ now: () => NOW, read: async () => stored }),
    detail = createPreparedScenesApiHandler({ now: () => NOW, read: async () => stored }), requests = [];
  const client = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, fetchImpl: (url, options) => {
    requests.push(url); const request = new Request(`https://example.test${url}`, options); return url.includes('/focus-scenes?') ? focus(request, {}) : detail(request, {});
  } }), f = nativeViewer(), layer = createPreparedGdacsLayer({ getDemand: () => selection, client });
  let context; layer.setClusterInspectionListener(value => { context = value; }); layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy());
  await layer.update(f.viewer); const cluster = current.scene.clusters[0], symbols = f.viewer.scene.primitives.get(0);
  const clusterSymbol = Array.from({ length: symbols.length }, (_, i) => symbols.get(i)).find(symbol => symbol.id.id === cluster.id);
  f.pick(clusterSymbol); assert.ok(context); assert.equal(f.flights.length, 0); assert.equal(context.isCurrent(), true);
  const page = await context.loadPage(null, {}); assert.equal(page.count, cluster.count); assert.equal(page.members[0].role, 'member');
  assert.equal(requests.length, 2, 'members still have no eager full-body proof');
  assert.equal(await context.inspectMember(page.members[0]), true); assert.ok(gdacsNoticeSelection(f.viewer.selectedEntity, Cesium.JulianDate.now()));
  assert.equal(context.signal.aborted, true); assert.equal(requests.length, 3);
  assert.deepEqual(layer.getRowControls().items.find(row => row.id === cluster.id).inspectParams, { inspectMembers: cluster.id });
  assert.equal(layer.setParams({ inspectMembers: cluster.id }), true); const again = context;
  layer.disable(); assert.equal(again.signal.aborted, true); await assert.rejects(again.loadPage(), { name: 'AbortError' });
  assert.equal(await again.inspectMember(page.members[0]), false); assert.equal(f.viewer.selectedEntity, undefined);
});

test('late compact proof cannot select after demand cancellation, source change, or history admission', async t => {
  const prepared = await usgsPrepared(), current = await focusView(prepared), f = nativeViewer(), gates = [], signals = [];
  const layer = createPreparedEarthquakesLayer({ getDemand: () => focused, client: { load: async () => current, cancel() {},
    getFeature: async (_item, _source, { signal }) => { const gate = Promise.withResolvers(); gates.push(gate); signals.push(signal); await gate.promise;
      return { source: prepared.source, feature: prepared.content.features[0] }; } } });
  layer.init(f.viewer); layer.enable(); t.after(() => layer.destroy()); await layer.update(f.viewer);
  const old = layer.setParams({ inspect: current.scene.features[0].id }); layer.disable(); assert.equal(signals[0].aborted, true);
  gates[0].resolve(); assert.equal(await old, false); assert.equal(f.viewer.selectedEntity, undefined);
  layer.enable(); await layer.update(f.viewer); const pending = layer.setParams({ inspect: current.scene.features[0].id });
  f.viewer.earthTime = { getState: () => ({ mode: 'history' }) }; gates[1].resolve(); assert.equal(await pending, false);
  assert.equal(f.viewer.selectedEntity, undefined); assert.equal(layer.getAnalystRecords().length, 0, 'compact display is not a full analyst record');
});

test('cold proof checks editor, command, navigation and camera intent before selection while a removed originating row may safely finish', async () => {
  const prepared = await gdacsPrepared(), current = await focusView(prepared), compact = current.scene.features[0];
  for (const action of ['editor', 'command', 'navigation', 'workspace', 'camera', 'row-refresh', 'unchanged']) {
    const origin = { isConnected: true, closest: () => null }, body = {}, command = { open: false }, notebook = { hidden: true, inert: false },
      documentRef = { hidden: false, body, documentElement: {}, activeElement: origin,
        getElementById: id => id === 'command-palette' ? command : id === 'notebook-panel' ? notebook : null },
      f = nativeViewer(), gate = Promise.withResolvers(), callbacks = [];
    const layer = createPreparedGdacsLayer({ documentRef, getDemand: () => focused, client: { load: async () => current,
      getFeature: async () => { await gate.promise; return { source: prepared.source, feature: prepared.content.features.find(feature => feature.id === compact.id) }; } } });
    layer.setFeatureInspectionListener(entity => callbacks.push(entity)); layer.init(f.viewer); layer.enable(); await layer.update(f.viewer);
    const selecting = layer.setParams({ inspect: compact.id });
    if (action === 'editor') documentRef.activeElement = { closest: () => ({ tagName: 'TEXTAREA' }) };
    if (action === 'command') command.open = true;
    if (action === 'navigation') documentRef.activeElement = { isConnected: true, closest: () => null };
    if (action === 'workspace') { notebook.hidden = false; origin.isConnected = false; documentRef.activeElement = body; }
    if (action === 'camera') f.viewer.camera.changed.raiseEvent();
    if (action === 'row-refresh') { origin.isConnected = false; documentRef.activeElement = body; }
    gate.resolve(); const allowed = ['row-refresh', 'unchanged'].includes(action);
    assert.equal(await selecting, allowed, action); assert.equal(Boolean(f.viewer.selectedEntity), allowed, action);
    assert.equal(callbacks.length, allowed ? 1 : 0, 'focus handoff only follows admitted explicit selection'); layer.destroy();
  }
});
