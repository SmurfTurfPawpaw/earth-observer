import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createObservedAircraftLayer } from './aircraft.js';

function globe() {
  let dataSource;
  const moveEnd = new Cesium.Event();
  return {
    dataSources: { add(value) { dataSource = value; }, remove() { dataSource = null; } },
    scene: { requestRender() {} },
    canvas: { clientWidth: 800, clientHeight: 600 },
    camera: { positionCartographic: Cesium.Cartographic.fromDegrees(4.35, 50.85, 90000), pickEllipsoid() {}, moveEnd },
    isDestroyed: () => false,
    get source() { return dataSource; },
  };
}
const snapshot = (longitude = 4.35) => ({
  source: 'Test receiver', coverage: 'Observed receiver coverage', observedAtMs: 1791676800000, ageMs: 15000,
  records: [{ id: 'abc123', callsign: 'EX123', latitude: 50.85, longitude, positionTimeMs: 1791676785000, ellipsoidAltitudeM: 1200, speedMps: 220, courseDeg: 90 }],
});

test('aircraft positions stay at the last observation as time advances and selection follows a new observation', async () => {
  const viewer = globe();
  let next = snapshot();
  const source = { getSnapshot: async () => next };
  const layer = createObservedAircraftLayer({ source });
  layer.init(viewer); layer.enable();
  await layer.update(viewer);
  const first = viewer.source.entities.getById('flights:abc123');
  const now = first.position.getValue(Cesium.JulianDate.now());
  const future = first.position.getValue(Cesium.JulianDate.fromIso8601('2030-01-01T00:00:00Z'));
  assert.ok(Cesium.Cartesian3.equals(now, future), 'Reported speed must not advance the marker');
  assert.equal(first.properties.positionType.getValue(), 'Receiver observation');
  viewer.selectedEntity = first;
  next = snapshot(4.36);
  await layer.update(viewer);
  assert.equal(viewer.selectedEntity.id, 'flights:abc123');
  assert.notEqual(viewer.selectedEntity, first);
  const updated = Cesium.Cartographic.fromCartesian(viewer.selectedEntity.position.getValue(Cesium.JulianDate.now()));
  assert.ok(Math.abs(Cesium.Math.toDegrees(updated.longitude) - 4.36) < 1e-8);
  assert.equal(layer.getStats().observedAtMs, 1791676800000);
  layer.destroy();
});

test('disabling an aircraft layer cancels its request and rejects a late response', async () => {
  const viewer = globe();
  let resolve, signal;
  const source = { getSnapshot: (_query, options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); } };
  const layer = createObservedAircraftLayer({ source });
  layer.init(viewer); layer.enable();
  const pending = layer.update(viewer);
  layer.disable();
  assert.equal(signal.aborted, true);
  resolve(snapshot());
  assert.equal(await pending, false);
  assert.equal(viewer.source.show, false);
  assert.equal(viewer.source.entities.values.length, 0);
  layer.destroy();
});
