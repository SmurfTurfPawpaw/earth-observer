import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createObservedAircraftLayer } from './aircraft.js';
import { aircraftGeodesic, projectAircraftObservation, interpolateAircraftObservations } from './aircraft-motion.js';

function globe() {
  let dataSource;
  const moveEnd = new Cesium.Event();
  return {
    dataSources: { add(value) { dataSource = value; }, remove() { dataSource = null; } },
    scene: { requestRender() {}, preRender: new Cesium.Event() },
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
  assert.equal(viewer.selectedEntity, first, 'A newer source update retains the same selected entity');
  const updated = Cesium.Cartographic.fromCartesian(viewer.selectedEntity.position.getValue(Cesium.JulianDate.now()));
  assert.ok(Math.abs(Cesium.Math.toDegrees(updated.longitude) - 4.36) < 1e-8);
  assert.equal(layer.getStats().observedAtMs, 1791676800000);
  layer.destroy();
});

function harness(start) {
  let time = start, id = 0;
  const timers = new Map(), listeners = new Map(), holds = new Set();
  const documentRef = { hidden: false, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    visibility(hidden) { this.hidden = hidden; for (const fn of listeners.get('visibilitychange') || []) fn(); } };
  return { documentRef, timers, holds, now: () => time,
    render: { holdContinuousRender(owner) { holds.add(owner); }, releaseContinuousRender(owner) { holds.delete(owner); } },
    setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time && timers.delete(id)) timer.fn(); },
  };
}

test('buffered rendering waits cheaply, advances without fetching, retains selection and facts, then stops at dated edge expiry', async () => {
  const initial = snapshot(), record = { ...initial.records[0], positionTimeQuality: 'reported' }, origin = record.positionTimeMs;
  const timing = harness(origin), viewer = globe(); let next = { ...initial, records: [record] }, calls = 0, changes = 0;
  const layer = createObservedAircraftLayer({ ...timing, predictionEnabled: true, source: { async getSnapshot() { calls++; return next; } } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const entity = viewer.source.entities.getById('flights:abc123'); viewer.selectedEntity = entity; entity.definitionChanged.addEventListener(() => { changes++; });
  const first = Cesium.Cartesian3.clone(entity.position.getValue(Cesium.JulianDate.now()));
  assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 1);
  assert.equal(entity.properties.positionType.getValue(), 'Receiver observation'); assert.equal(entity.properties.bufferState.getValue(), 'awaiting-buffer');
  assert.equal(entity.properties.observedLongitude.getValue(), record.longitude); assert.equal(entity.properties.positionObservedAt.getValue(), new Date(origin).toISOString());
  timing.advance(24999); assert.equal(timing.holds.size, 0); assert.ok(Cesium.Cartesian3.equals(first, entity.position.getValue()));
  timing.advance(1); assert.deepEqual([...timing.holds], ['aircraft:flights']);
  timing.advance(1000); viewer.scene.preRender.raiseEvent();
  assert.ok(Cesium.Cartesian3.distance(first, entity.position.getValue()) > 200); assert.equal(calls, 1); assert.ok(changes > 0);
  timing.advance(5000); viewer.scene.preRender.raiseEvent(); const before = Cesium.Cartesian3.clone(entity.position.getValue());
  assert.equal(timing.holds.size, 0); assert.equal(entity.properties.positionType.getValue(), 'Expired estimate');
  const predicted = projectAircraftObservation(record, origin + 30000, { horizonMs: 45000 }), shifted = aircraftGeodesic(predicted, 0, 100);
  const newer = { ...record, ...shifted, positionTimeMs: origin + 30000 };
  next = { ...initial, records: [newer] }; await layer.update(viewer);
  assert.equal(viewer.selectedEntity, entity); assert.equal(viewer.source.entities.values.length, 1);
  assert.ok(Cesium.Cartesian3.distance(before, entity.position.getValue()) < .1, 'Correction starts from the old display while the new facts become exact immediately');
  assert.equal(entity.properties.observedLongitude.getValue(), newer.longitude); assert.equal(entity.properties.positionObservedAt.getValue(), new Date(newer.positionTimeMs).toISOString());
  assert.equal(entity.properties.estimatedAt.getValue(), new Date(origin + 6000).toISOString());
  assert.equal(entity.properties.bufferObservedAt.getValue(), new Date(origin).toISOString() + ' → ' + new Date(origin + 30000).toISOString());
  assert.equal(entity.properties.previousPredictionErrorM.getValue(), undefined); assert.equal(entity.properties.openLoopDiagnosticHorizonSeconds.getValue(), 30);
  assert.ok(Math.abs(entity.properties.openLoopDiagnosticErrorM.getValue() - 100) < .1); assert.equal(entity.properties.presentationDelaySeconds.getValue(), 25);
  assert.equal(timing.holds.size, 1);
  timing.advance(1200); viewer.scene.preRender.raiseEvent(); assert.equal(entity.properties.correctionRemainingM.getValue(), undefined);
  const supported = interpolateAircraftObservations(record, newer, origin + 7200).position;
  const target = Cesium.Cartesian3.fromDegrees(supported.longitude, supported.latitude, supported.altitudeM);
  assert.ok(Cesium.Cartesian3.distance(target, entity.position.getValue()) < .1, 'Correction reaches the advancing buffered cursor');
  timing.advance(27800); assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0);
  assert.equal(entity.properties.positionType.getValue(), 'Expired estimate'); assert.equal(layer.getStats().motionActiveCount, 0);
  assert.equal(entity.properties.estimatedAt.getValue(), new Date(origin + 35000).toISOString());
  const stopped = Cesium.Cartesian3.clone(entity.position.getValue()); timing.advance(300000); viewer.scene.preRender.raiseEvent();
  assert.ok(Cesium.Cartesian3.equals(stopped, entity.position.getValue())); assert.equal(calls, 2);
  layer.destroy(); assert.equal(timing.holds.size, 0);
});

test('hidden resume catches up expiry, history disable and context loss release holds, and absent records remove only their owned entities', async () => {
  const initial = snapshot(), record = { ...initial.records[0], positionTimeQuality: 'reported' }, timing = harness(record.positionTimeMs + 1000), viewer = globe();
  const canvasListeners = new Map(); viewer.canvas.addEventListener = (name, fn) => canvasListeners.set(name, fn); viewer.canvas.removeEventListener = (name) => canvasListeners.delete(name);
  let next = { ...initial, records: [record] };
  const layer = createObservedAircraftLayer({ ...timing, predictionEnabled: true, source: { getSnapshot: async () => next } });
  layer.init(viewer); layer.enable(); await layer.update(viewer); assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 1);
  timing.documentRef.visibility(true); assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0); assert.equal(layer.getStats().motionActiveCount, 0);
  timing.advance(120000); timing.documentRef.visibility(false); assert.equal(timing.holds.size, 0); assert.equal(layer.getStats().expiredCount, 1);
  next = { ...initial, records: [{ ...record, positionTimeMs: timing.now() }] }; await layer.update(viewer); assert.equal(timing.holds.size, 0);
  timing.advance(25000); assert.equal(timing.holds.size, 1);
  layer.disable(); assert.equal(timing.holds.size, 0); assert.equal(viewer.source.show, false);
  layer.enable(); assert.equal(timing.holds.size, 1);
  next = { ...initial, records: [] }; await layer.update(viewer); assert.equal(viewer.source.entities.values.length, 0); assert.equal(timing.holds.size, 0);
  next = { ...initial, records: [{ ...record, positionTimeMs: timing.now() + 1 }] }; timing.advance(1); await layer.update(viewer); assert.equal(timing.holds.size, 0);
  timing.advance(25000); assert.equal(timing.holds.size, 1);
  canvasListeners.get('webglcontextlost')(); assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0);
  timing.documentRef.visibility(true); timing.documentRef.visibility(false); assert.equal(timing.holds.size, 0); assert.equal(await layer.update(viewer), false);
  layer.destroy(); assert.equal(canvasListeners.size, 0); assert.equal(timing.timers.size, 0);
});

test('an early receiver refresh keeps the waiting marker stable and selected latest facts exact through buffer activation', async () => {
  const initial = snapshot(), record = { ...initial.records[0], positionTimeQuality: 'reported' }, origin = record.positionTimeMs;
  const timing = harness(origin), viewer = globe(); let next = { ...initial, records: [record] };
  const layer = createObservedAircraftLayer({ ...timing, predictionEnabled: true, source: { getSnapshot: async () => next } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const entity = viewer.source.entities.getById('flights:abc123'); viewer.selectedEntity = entity;
  const waiting = Cesium.Cartesian3.clone(entity.position.getValue());
  timing.advance(10000);
  const early = { ...record, ...aircraftGeodesic(record, 90, 2200), positionTimeMs: origin + 10000 };
  next = { ...initial, records: [early] }; await layer.update(viewer);
  assert.ok(Cesium.Cartesian3.equals(waiting, entity.position.getValue())); assert.equal(timing.holds.size, 0);
  assert.equal(viewer.selectedEntity, entity); assert.equal(entity.properties.positionType.getValue(), 'Buffered receiver observation');
  assert.equal(entity.properties.observedLongitude.getValue(), early.longitude);
  assert.equal(entity.properties.positionObservedAt.getValue(), new Date(origin + 10000).toISOString());
  assert.equal(entity.properties.displayObservedAt.getValue(), new Date(origin).toISOString());
  timing.advance(14999); assert.ok(Cesium.Cartesian3.equals(waiting, entity.position.getValue())); assert.equal(timing.holds.size, 0);
  timing.advance(1); assert.ok(Cesium.Cartesian3.equals(waiting, entity.position.getValue())); assert.equal(timing.holds.size, 1);
  timing.advance(1000); viewer.scene.preRender.raiseEvent();
  assert.ok(Cesium.Cartesian3.distance(waiting, entity.position.getValue()) > 200);
  assert.equal(entity.properties.positionObservedAt.getValue(), new Date(origin + 10000).toISOString());
  layer.destroy(); assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0);
});

test('prepared genuine history starts an immediately supported bracket before first presentation and invalidations revalidate once', async () => {
  const initial = snapshot(), prior = { ...initial.records[0], positionTimeQuality: 'reported' }, origin = prior.positionTimeMs;
  const latest = { ...prior, ...aircraftGeodesic(prior, 90, 6600), positionTimeMs: origin + 30000 };
  const timing = harness(origin + 31000), viewer = globe(), calls = [];
  const prepared = { ...initial, prepared: true, observedAtMs: latest.positionTimeMs, ageMs: 1000, records: [latest], history: [
    { ...prior, id: 'not-latest' }, { ...prior, positionTimeQuality: 'unknown' }, prior] };
  const layer = createObservedAircraftLayer({ ...timing, predictionEnabled: true, source: { async getSnapshot(query, options) { calls.push({ query, options }); return prepared; } } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const entity = viewer.source.entities.getById('flights:abc123'); viewer.selectedEntity = entity;
  assert.equal(viewer.source.entities.values.length, 1); assert.equal(timing.holds.size, 1); assert.equal(layer.getStats().interpolatingCount, 1);
  const supported = interpolateAircraftObservations(prior, latest, origin + 6000).position;
  assert.ok(Cesium.Cartesian3.distance(entity.position.getValue(), Cesium.Cartesian3.fromDegrees(supported.longitude, supported.latitude, supported.altitudeM)) < .1);
  assert.equal(entity.properties.correctionRemainingM.getValue(), undefined, 'Backfilled facts are not played as receipt corrections');
  assert.equal(entity.properties.positionObservedAt.getValue(), new Date(latest.positionTimeMs).toISOString());
  assert.equal(entity.properties.estimatedAt.getValue(), new Date(origin + 6000).toISOString());
  assert.equal(entity.properties.bufferObservedAt.getValue(), new Date(origin).toISOString() + ' → ' + new Date(latest.positionTimeMs).toISOString());
  assert.equal(calls[0].query.radiusKm, 50); assert.equal(calls[0].options.revalidate, false);
  const before = Cesium.Cartesian3.clone(entity.position.getValue()); timing.advance(1000); viewer.scene.preRender.raiseEvent();
  assert.ok(Cesium.Cartesian3.distance(before, entity.position.getValue()) > 200); assert.equal(calls.length, 1);
  layer.invalidatePreparedSnapshot(); await layer.update(viewer); assert.equal(calls[1].options.revalidate, true);
  await layer.update(viewer); assert.equal(calls[2].options.revalidate, false); assert.equal(viewer.selectedEntity, entity);
  layer.destroy();
});

test('stale prepared history cannot start or restart animation and original cached fixes remain dated', async () => {
  const initial = snapshot(), prior = { ...initial.records[0], positionTimeQuality: 'reported' }, origin = prior.positionTimeMs;
  const latest = { ...prior, ...aircraftGeodesic(prior, 90, 6600), positionTimeMs: origin + 30000 };
  const timing = harness(origin + 31000), viewer = globe();
  const preserved = { ...initial, prepared: true, stale: true, freshness: 'stale', records: [latest], history: [prior] };
  const layer = createObservedAircraftLayer({ ...timing, predictionEnabled: true, source: { getSnapshot: async () => preserved } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const entity = viewer.source.entities.getById('flights:abc123'), fixed = Cesium.Cartesian3.clone(entity.position.getValue());
  assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0); assert.equal(entity.properties.bufferState.getValue(), 'stale-observation');
  assert.equal(entity.properties.freshness.getValue(), 'Preserved source observations');
  assert.equal(entity.properties.positionObservedAt.getValue(), new Date(latest.positionTimeMs).toISOString());
  timing.advance(60000); await layer.update(viewer); viewer.scene.preRender.raiseEvent();
  assert.equal(timing.holds.size, 0); assert.equal(timing.timers.size, 0); assert.ok(Cesium.Cartesian3.equals(fixed, entity.position.getValue()));
  assert.equal(entity.properties.estimatedAt.getValue(), undefined); assert.equal(layer.getStats().stale, true);
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
