import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
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
test('USGS body completion honors cancellation even with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { features: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
