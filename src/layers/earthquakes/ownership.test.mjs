import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import * as Cesium from 'cesium';
import { depthColor } from './model.js';
function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createEarthquakesLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}
const row = {
  stableId: 'event-a',
  usgsId: 'event-a',
  lon: 30,
  lat: 20,
  depthKm: 3,
  mag: 4,
  place: 'Fixture',
  time: 1000,
};
test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});
test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});
test('pixel markers retain reported positions, selectable entity identity and source properties without geographic disks or depth overrides', async () => {
  const rows = [row, { ...row, stableId: 'deep-large', usgsId: 'deep-large', mag: 10, depthKm: 400 }];
  const h = harness({ getSnapshot: async () => rows }); await h.layer.update(h.viewer);
  const at = Cesium.JulianDate.now(), entities = h.sources[0].entities;
  for (const source of rows) {
    const entity = entities.getById(`earthquake:${source.stableId}`);
    assert.ok(entity instanceof Cesium.Entity, 'the renderer keeps the source entity available to Cesium picking');
    assert.equal(entity.ellipse, undefined);
    assert.ok(entity.point instanceof Cesium.PointGraphics);
    assert.equal(entity.point.pixelSize.getValue(at), 11, 'magnitude does not create a geographic footprint or unbounded screen marker');
    assert.equal(entity.point.outlineWidth.getValue(at), 2);
    assert.equal(entity.point.color.getValue(at).equals(depthColor(source.depthKm)), true);
    assert.equal(entity.point.heightReference.getValue(at), Cesium.HeightReference.CLAMP_TO_GROUND);
    assert.equal(entity.point.disableDepthTestDistance, undefined, 'normal globe/surface occlusion remains available');
    assert.equal(entity.position.getValue(at).equals(Cesium.Cartesian3.fromDegrees(source.lon, source.lat)), true);
    assert.deepEqual(entity.properties.getValue(at), { usgsId: source.usgsId, mag: source.mag, place: source.place, time: source.time, depth: source.depthKm });
  }
  assert.equal(h.events.length, 1); assert.deepEqual(h.events[0][1].map(entry => entry.id).sort(), rows.map(source => source.stableId).sort());
  assert.equal(h.events[0][2].moving, false); h.layer.destroy();
});
test('unchanged refresh preserves the picked object and property bag; corrected facts invalidate proof in place and only absent records clear selection', async () => {
  let rows = [row]; const h = harness({ getSnapshot: async () => rows }); await h.layer.update(h.viewer);
  const entities = h.sources[0].entities, selected = entities.getById('earthquake:event-a'), bag = selected.properties, at = Cesium.JulianDate.now();
  entities.collectionChanged.addEventListener(Cesium.Viewer.prototype._onEntityCollectionChanged, h.viewer);
  h.viewer.selectedEntity = selected; bag.addProperty('_worldEvent', { retained: 'fixture-proof' });
  const changes = []; entities.collectionChanged.addEventListener((_collection, added, removed) => changes.push({ added, removed }));
  rows = [{ ...row }]; await h.layer.update(h.viewer);
  assert.equal(h.viewer.selectedEntity === selected, true); assert.equal(entities.getById(selected.id) === selected, true);
  assert.equal(selected.properties === bag, true); assert.equal(bag.hasProperty('_worldEvent'), true); assert.equal(changes.length, 0);
  let staleAtCorrection = false;
  bag.definitionChanged.addEventListener(() => { if (bag.mag?.getValue(at) === 5.2 && bag.hasProperty('_worldEvent')) staleAtCorrection = true; });
  rows = [{ ...row, mag: 5.2, lon: 31, depthKm: 400, place: 'Corrected fixture place' }]; await h.layer.update(h.viewer);
  assert.equal(h.viewer.selectedEntity === selected, true); assert.equal(selected.properties === bag, true);
  assert.equal(staleAtCorrection, false); assert.equal(bag.hasProperty('_worldEvent'), false);
  assert.equal(bag.mag.getValue(at), 5.2); assert.equal(bag.place.getValue(at), 'Corrected fixture place');
  assert.equal(selected.position.getValue(at).equals(Cesium.Cartesian3.fromDegrees(31, row.lat)), true);
  assert.equal(selected.point.color.getValue(at).equals(depthColor(400)), true);
  rows = []; await h.layer.update(h.viewer); assert.equal(h.viewer.selectedEntity, undefined);
  assert.equal(changes.flatMap(change => change.removed).length, 1); h.layer.destroy();
});
test('failed and canceled refresh leave the last valid picked object and retained proof untouched', async () => {
  let mode = 'valid', release; const h = harness({ getSnapshot: () => {
    if (mode === 'failed') throw new Error('TEST ONLY source unavailable');
    if (mode === 'pending') return new Promise(resolve => { release = resolve; }); return Promise.resolve([row]);
  } });
  await h.layer.update(h.viewer); const selected = h.sources[0].entities.getById('earthquake:event-a'); h.viewer.selectedEntity = selected;
  selected.properties.addProperty('_worldEvent', { retained: 'fixture-proof' });
  mode = 'failed'; assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.viewer.selectedEntity === selected, true); assert.equal(selected.properties.hasProperty('_worldEvent'), true);
  mode = 'pending'; const work = h.layer.update(h.viewer); h.layer.disable(h.viewer); h.layer.enable(h.viewer); release([{ ...row, mag: 9 }]);
  assert.equal(await work, false); assert.equal(h.sources[0].entities.getById(selected.id) === selected, true);
  assert.equal(selected.properties.mag.getValue(Cesium.JulianDate.now()), row.mag); assert.equal(selected.properties.hasProperty('_worldEvent'), true); h.layer.destroy();
});
test('cached and fresh snapshots share the manager cancellation owner; late cache cannot paint after history or area supersession', async () => {
  const owner = new AbortController(), began = Promise.withResolvers(), finished = Promise.withResolvers(); let onCached, signal;
  const h = harness({ getSnapshot: options => { ({ onCached, signal } = options); began.resolve(); return finished.promise; } });
  const pending = h.layer.update(h.viewer, { signal: owner.signal }); await began.promise;
  owner.abort(); assert.equal(signal.aborted, true); onCached([row]); finished.resolve([row]);
  assert.equal(await pending, false); assert.equal(h.layer.getStats().count, 0); assert.equal(h.events.length, 0); h.layer.destroy();
});

test('stored check clocks and scientific metadata survive cached-first reconciliation without replacing an unchanged selection', async () => {
  const at = Date.now(), retained = new Date(at - 3600000).toISOString(), checked = new Date(at - 10000).toISOString();
  const storedRow = { ...row, sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/event-a', updatedAt: at - 15000,
    eventType: 'quarry blast', reviewStatus: 'reviewed', sourceTitle: 'Reported quarry blast' };
  const view = (records, cached = false) => ({ records, receipt: { id: `receipt:${'a'.repeat(64)}`, fence: 1, recordedAt: retained, capturedAt: retained, sourceUpdatedAt: retained },
    check: { checkedAt: checked, lastSuccessfulAt: checked, sourceGeneratedAt: checked, status: 'ready' },
    factualEditionAgeMs: 3600000, retainedSourceGenerationAgeMs: 3600000, sourceGenerationAgeMs: 10000, browserReadAt: at,
    browserCache: cached ? 'STALE' : null, browserCachedAt: cached ? at - 1000 : null, stale: false, coverage: { complete: true, recordCount: records.length } });
  let rows = [storedRow], notifications = 0;
  const h = harness({ getSnapshot: async ({ onCached }) => { onCached(view(rows, true)); return view(rows); } });
  h.layer.setRowControlsListener(() => { notifications++; }); await h.layer.update(h.viewer);
  const selected = h.sources[0].entities.getById('earthquake:event-a'), bag = selected.properties, time = Cesium.JulianDate.now();
  h.viewer.selectedEntity = selected; bag.addProperty('_worldEvent', { retained: 'old-proof' });
  rows = [{ ...storedRow }]; await h.layer.update(h.viewer);
  assert.equal(h.viewer.selectedEntity, selected); assert.equal(selected.properties, bag); assert.equal(bag.hasProperty('_worldEvent'), true);
  assert.equal(bag.eventType.getValue(time), 'quarry blast'); assert.equal(bag.sourceUrl.getValue(time), storedRow.sourceUrl);
  const stats = h.layer.getStats(); assert.equal(stats.lastUpdate, Date.parse(retained)); assert.equal(stats.checkedAt, checked);
  assert.equal(stats.sourceGeneratedAt, checked); assert.equal(stats.retainedSourceGeneratedAt, retained); assert.equal(stats.receipt.recordedAt, retained);
  assert.ok(stats.sourceAgeMs >= 10000 && stats.sourceAgeMs < 120000); assert.equal(stats.stale, false); assert.equal(notifications, 4);
  rows = [{ ...storedRow, updatedAt: at, reviewStatus: 'automatic', eventType: null, sourceTitle: 'Corrected scientific type unknown' }];
  await h.layer.update(h.viewer); assert.equal(selected.properties, bag); assert.equal(bag.hasProperty('_worldEvent'), false);
  assert.equal(bag.updatedAt.getValue(time), at); assert.equal(bag.reviewStatus.getValue(time), 'automatic'); assert.equal(bag.hasProperty('eventType'), true);
  assert.equal(bag.getValue(time).eventType, null, 'explicit provider unknown remains present and is never coerced to earthquake');
  h.layer.destroy();
});
