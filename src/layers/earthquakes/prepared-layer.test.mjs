import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPreparedEarthquakesLayer } from './prepared-layer.js';
import { normalizeRegionalSceneDelivery } from '../../core/regional-scene-client.js';
import { buildPreparedUsgsScene, selectPreparedUsgsCells } from '../../../worker/prepared-usgs-scene.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from '../../core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from '../../core/plugin-evidence.js';
import { mapSymbolImage } from '../../core/map-symbols.js';

const NOW = Date.parse('2026-10-12T09:00:00.000Z'), featuresDemand = { level: 0, cells: [[4, 0]], mode: 'features' };
const CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK;
async function viewFixture(demand = featuresDemand, mag = 3, fence = 1) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl, generated: NOW - 2000, count: 2 },
    features: [0, 1].map(i => ({ type: 'Feature', id: `us-prepared-${i}`, properties: { mag, place: 'Reported location', time: NOW - 4000,
      updated: NOW - 3000, status: 'reviewed', type: i ? 'quarry blast' : 'earthquake', url: `https://earthquake.usgs.gov/earthquakes/eventpage/us-prepared-${i}` },
      geometry: { type: 'Point', coordinates: [4 + i, 50, 12] } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), overview = usgsLiveDayOverview(decoded);
  const receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence, factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw),
    artifactSha256: await pluginFactsDigest(overview), capturedAt: new Date(NOW - 1000).toISOString(), recordedAt: new Date(NOW).toISOString(), sourceUpdatedAt: decoded.sourceGeneratedAt };
  const prepared = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: 2 } });
  return normalizeRegionalSceneDelivery({ schemaVersion: 1, configured: true, available: true, pending: false, policyId: prepared.content.policyId,
    source: prepared.source, check: { checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + 60000).toISOString(), lastSuccessfulAt: new Date(NOW).toISOString(),
      sourceGeneratedAt: decoded.sourceGeneratedAt, status: 'ready' }, stale: false, sourceGenerationAgeMs: 2000,
    kind: 'prepared-usgs-scene-delivery', transport: 'snapshot', snapshotRequired: false, delta: null, scene: await selectPreparedUsgsCells(prepared, demand) }, demand, { now: () => NOW });
}
function harness(client, initialDemand = featuresDemand) {
  const actions = new Map(), native = [], flights = [], changed = new Cesium.Event(), moveEnd = new Cesium.Event();
  let selected, tracked, picked, demand = initialDemand, refreshes = 0;
  actions.set(CLICK, () => native.push('native'));
  const viewer = { scene: { primitives: new Cesium.PrimitiveCollection(), requestRender() {}, pick: () => picked },
    camera: { changed, moveEnd, flyTo: value => flights.push(value) }, isDestroyed: () => false,
    selectedEntityChanged: new Cesium.Event(), trackedEntityChanged: new Cesium.Event(),
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (value, type) => actions.set(type, value), removeInputAction: type => actions.delete(type) } };
  Object.defineProperties(viewer, { selectedEntity: { get: () => selected, set(value) { if (selected !== value) { selected = value; viewer.selectedEntityChanged.raiseEvent(value); } } },
    trackedEntity: { get: () => tracked, set(value) { if (tracked !== value) { tracked = value; viewer.trackedEntityChanged.raiseEvent(value); } } } });
  const layer = createPreparedEarthquakesLayer({ client, getDemand: () => demand, debounceMs: 150 });
  layer.setDemandRefreshListener(() => refreshes++); layer.init(viewer); layer.enable(viewer);
  return { layer, viewer, actions, native, flights, changed, moveEnd,
    get refreshes() { return refreshes; }, setDemand(value) { demand = value; changed.raiseEvent(); },
    pick(symbol, type = CLICK) { picked = symbol ? { id: symbol.id, primitive: symbol } : null; actions.get(type)?.({ position: { x: 1, y: 2 } }); } };
}

test('native feature symbols carry exact reported coordinates and lazy pinned source selection without per-record Entities', async t => {
  const view = await viewFixture(), h = harness({ load: async () => view }); t.after(() => h.layer.destroy());
  assert.equal(await h.layer.update(h.viewer), true); assert.equal(h.viewer.scene.primitives.length, 2);
  const symbols = h.viewer.scene.primitives.get(0); assert.ok(symbols instanceof Cesium.BillboardCollection); assert.equal(symbols.length, 2);
  assert.equal(h.viewer.selectedEntity, undefined); assert.equal(symbols.get(0).id instanceof Cesium.Entity, false);
  assert.equal(symbols.get(0).image, mapSymbolImage('seismic')); assert.equal(symbols.get(0).disableDepthTestDistance, undefined);
  assert.equal(Cesium.Cartesian3.equals(symbols.get(0).position, Cesium.Cartesian3.fromDegrees(4, 50)), true);
  h.pick(symbols.get(0)); const selected = h.viewer.selectedEntity, properties = selected.properties.getValue();
  assert.ok(selected instanceof Cesium.Entity); assert.equal(selected.id, view.scene.features[0].id); assert.equal(selected.billboard, undefined);
  assert.equal(properties.sourceReceiptId, view.source.receiptId); assert.equal(properties.sourceFeatureRevision, view.scene.features[0].revision);
  assert.equal(properties.time, NOW - 4000); assert.equal(properties.updatedAt, NOW - 3000); assert.equal(properties.eventType, 'earthquake');
  h.pick(symbols.get(1)); assert.equal(h.viewer.selectedEntity.properties.eventType.getValue(), 'quarry blast');
  assert.equal(h.layer.getAnalystRecords().length, 2); assert.equal(h.layer.getStats().lastUpdate, NOW);
  assert.equal(h.layer.getStats().sourceGeneratedAt, new Date(NOW - 2000).toISOString());
  assert.ok(h.layer.getStats().editionMetrics.preparationMs >= 0); h.pick(null); assert.deepEqual(h.native, ['native']);
});

test('cluster badges are native cell-center summaries; activation zooms their bounds and never exposes invented analyst epicenters', async t => {
  // Only CSS font inspection is shimmed; native collections and their lifecycle remain real. No GPU is created.
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: name => ({ 'font-size': '12px', 'font-family': 'sans-serif',
      'font-style': 'normal', 'font-weight': '600', 'line-height': 'normal' })[name] }) } };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const demand = { ...featuresDemand, mode: 'clusters' }, view = await viewFixture(demand), h = harness({ load: async () => view }, demand);
  t.after(() => h.layer.destroy()); assert.equal(await h.layer.update(h.viewer), true);
  const symbols = h.viewer.scene.primitives.get(0), labels = h.viewer.scene.primitives.get(1), cell = view.scene.clusters[0];
  assert.equal(symbols.length, 1); assert.equal(labels.length, 1); assert.equal(labels.get(0).text, '2');
  assert.equal(Cesium.Cartesian3.equals(symbols.get(0).position, Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat)), true);
  h.pick(symbols.get(0)); assert.equal(h.viewer.selectedEntity, undefined); assert.equal(h.flights.length, 1);
  assert.equal(h.flights[0].destination.equals(Cesium.Rectangle.fromDegrees(cell.bounds.west, cell.bounds.south, cell.bounds.east, cell.bounds.north)), true);
  assert.deepEqual(h.layer.getAnalystRecords(), []); assert.equal(h.layer.getStats().count, 2); assert.equal(h.layer.getStats().drawnCount, 1);
  assert.equal(h.layer.getRowControls().items[0].detail, 'Area summary; not an epicenter');
});

test('unchanged editions retain selected identity/proof; corrected complete facts update it after the new receipt is committed', async t => {
  let value = await viewFixture(); const h = harness({ load: async () => value }); t.after(() => h.layer.destroy()); await h.layer.update(h.viewer);
  h.pick(h.viewer.scene.primitives.get(0).get(0)); const selected = h.viewer.selectedEntity, bag = selected.properties;
  bag.addProperty('_worldEvent', { old: true }); value = { ...value, browserReadAt: NOW + 1000 };
  await h.layer.update(h.viewer); assert.equal(h.viewer.selectedEntity, selected); assert.equal(selected.properties, bag); assert.equal(bag.hasProperty('_worldEvent'), true);
  value = await viewFixture(featuresDemand, 4, 2); const receipts = [];
  const stop = selected.definitionChanged.addEventListener((_entity, field) => { if (field === 'properties') receipts.push(h.layer.getStats().receipt.id); }); t.after(stop);
  await h.layer.update(h.viewer); assert.equal(h.viewer.selectedEntity, selected); assert.equal(selected.properties.mag.getValue(), 4);
  assert.equal(selected.properties.hasProperty('_worldEvent'), false); assert.deepEqual(receipts, [value.source.receiptId]);
});

test('pending and uncertain refresh preserve same-scope complete symbols and clocks; initial preparation stays enabled without an error', async t => {
  const first = await viewFixture(); let value = { pending: true }, fail = false;
  const h = harness({ load: async () => { if (fail) throw Error('Test failure'); return value; } }); t.after(() => h.layer.destroy());
  assert.equal(await h.layer.update(h.viewer), false); assert.equal(h.layer.getStats().pending, true); assert.equal(h.layer.getStats().error, null);
  fail = true; assert.equal(await h.layer.update(h.viewer), false); assert.equal(h.layer.getStats().pending, false);
  assert.equal(h.layer.getStats().status, 'unavailable'); assert.equal(h.layer.getStats().degraded, true); assert.equal(h.layer.getStats().error, null); fail = false;
  value = first; await h.layer.update(h.viewer); const symbols = h.viewer.scene.primitives.get(0); h.pick(symbols.get(0)); const selected = h.viewer.selectedEntity;
  value = { pending: true }; assert.equal(await h.layer.update(h.viewer), false); assert.equal(h.viewer.scene.primitives.get(0), symbols);
  assert.equal(h.layer.getStats().lastUpdate, NOW); assert.equal(h.viewer.selectedEntity, selected);
  fail = true; assert.equal(await h.layer.update(h.viewer), false); assert.equal(h.viewer.scene.primitives.get(0), symbols); assert.equal(h.layer.getStats().lastUpdate, NOW);
});

test('camera scope changes retain exact prior symbols with explicit incomplete demand until a complete atomic replacement', async t => {
  let demand = featuresDemand, view = await viewFixture(); const h = harness({ load: async () => view, select() {}, cancel() {} }); t.after(() => h.layer.destroy());
  await h.layer.update(h.viewer); const previous = h.viewer.scene.primitives.get(0); h.pick(previous.get(0)); const selected = h.viewer.selectedEntity;
  demand = { ...featuresDemand, cells: [[0, 0]] }; h.setDemand(demand);
  assert.equal(h.viewer.scene.primitives.length, 2); assert.equal(h.viewer.scene.primitives.get(0), previous); assert.equal(h.viewer.selectedEntity, selected);
  assert.equal(h.layer.getStats().count, 2); assert.equal(h.layer.getStats().pending, true); assert.equal(h.layer.getStats().requestedViewportComplete, false);
  assert.equal(h.layer.getStats().cohortCoverage.requestedViewportComplete, false); assert.deepEqual(h.layer.getStats().displayedSelection, featuresDemand);
  assert.deepEqual(h.layer.getStats().requestedSelection, demand); assert.equal(selected.properties.sourceReceiptId.getValue(), view.source.receiptId);
  demand = { ...featuresDemand, cells: [[1, 0]] }; h.setDemand(demand); h.moveEnd.raiseEvent();
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(h.refreshes, 1);
  view = await viewFixture(demand); assert.equal(await h.layer.update(h.viewer), true); assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().requestedViewportComplete, true); assert.equal(previous.isDestroyed(), true); assert.equal(h.viewer.selectedEntity, undefined);
});

test('a removed report clears both selected and tracked ownership when they share the same lazy Entity', async t => {
  let value = await viewFixture(); const h = harness({ load: async () => value }); t.after(() => h.layer.destroy());
  await h.layer.update(h.viewer); const symbol = h.viewer.scene.primitives.get(0).get(0); h.pick(symbol); h.pick(symbol, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  assert.equal(h.viewer.selectedEntity, h.viewer.trackedEntity);
  const demand = { ...featuresDemand, cells: [[0, 0]] }; h.setDemand(demand); value = await viewFixture(demand); await h.layer.update(h.viewer);
  assert.equal(h.viewer.selectedEntity, undefined); assert.equal(h.viewer.trackedEntity, undefined);
});

test('late source results and late native attachment cannot publish after disable/history cancellation or destroy', async () => {
  const first = await viewFixture(), next = await viewFixture(featuresDemand, 4, 2);
  for (const terminal of ['disable', 'destroy']) {
    let value = first, gate; const began = Promise.withResolvers();
    const h = harness({ load: () => gate ? (began.resolve(), gate.promise) : Promise.resolve(value), cancel() {} }); await h.layer.update(h.viewer);
    gate = Promise.withResolvers(); const pending = h.layer.update(h.viewer); await began.promise;
    h.layer[terminal](); if (terminal === 'disable') h.layer.enable(); gate.resolve(next);
    assert.equal(await pending, false); assert.equal(h.layer.getStats().lastUpdate, terminal === 'disable' ? NOW : null); h.layer.destroy();
  }
  for (const terminal of ['disable', 'destroy']) {
    let value = first; const h = harness({ load: async () => value }); await h.layer.update(h.viewer); const previous = h.viewer.scene.primitives.get(0);
    const attaching = Promise.withResolvers(), gate = Promise.withResolvers(), add = h.viewer.scene.primitives.add.bind(h.viewer.scene.primitives);
    h.viewer.scene.primitives.add = collection => { attaching.resolve(); return gate.promise.then(() => add(collection)); };
    value = next; const pending = h.layer.update(h.viewer); await attaching.promise; h.layer[terminal](); gate.resolve();
    assert.equal(await pending, false); assert.equal(h.viewer.scene.primitives.length, terminal === 'disable' ? 2 : 0);
    if (terminal === 'disable') { assert.equal(h.viewer.scene.primitives.get(0), previous); assert.equal(previous.show, false); assert.equal(h.layer.getStats().receipt.fence, 1); }
    h.layer.destroy(); assert.equal(h.viewer.scene.primitives.length, 0);
  }
});

test('destroyed input wrapper and camera listeners preserve ordinary native selection without further demand work', async () => {
  const view = await viewFixture(), h = harness({ load: async () => view }); await h.layer.update(h.viewer);
  const retired = h.actions.get(CLICK), decorated = event => retired(event); h.actions.set(CLICK, decorated);
  h.layer.destroy(); h.changed.raiseEvent(); decorated({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.native, ['native']); assert.equal(h.viewer.scene.primitives.length, 0); assert.equal(h.refreshes, 0);
});
