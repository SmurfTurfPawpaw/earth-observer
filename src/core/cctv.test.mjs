import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCamerasLayer } from './cctv.js';

function globe() {
  const primitives = new Cesium.PrimitiveCollection(), actions = new Map(); let picked;
  const viewer = { dataSources: new Cesium.DataSourceCollection(), entities: new Cesium.EntityCollection(),
    scene: { primitives, requestRender() {}, pick: () => picked }, isDestroyed: () => false,
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (fn, type) => actions.set(type, fn), removeInputAction: type => actions.delete(type) },
    get source() { return primitives.length ? primitives.get(primitives.length - 1) : null; },
    pick(index = 0) {
      const point = this.source.get(index); picked = { id: point.id, primitive: point };
      actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cesium.Cartesian2() }); return this.selectedEntity;
    } };
  return viewer;
}
const camera = { id: 'calgary-86', name: 'Fixture intersection', lat: 51.046, lon: -114.063, credit: 'City of Calgary' };

test('local cameras send only rounded area fields and expose unsupported empty coverage without an error', async () => {
  const viewer = globe(), calls = [];
  const layer = createCamerasLayer({ fetchImpl: async (url) => {
    calls.push(url); return Response.json({ sources: [], providers: [], coverage: { status: 'unsupported', note: 'No reviewed camera provider covers this area.' } });
  } });
  layer.init(viewer); layer.setLocalArea({ lat: 50.850123, lon: 4.351234, radiusKm: 10 }); layer.enable();
  assert.equal(await layer.update(viewer), true);
  assert.equal(calls[0], '/api/cctv/sources?lat=50.85&lon=4.351&radiusKm=10');
  assert.equal(layer.getStats().count, 0); assert.equal(layer.getStats().error, null); assert.match(layer.getStats().coverage, /No reviewed/);
  layer.destroy();
});

test('global camera requests remain unscoped and local attribution includes only visible camera records', async () => {
  const viewer = globe(), calls = [];
  const layer = createCamerasLayer({ fetchImpl: async (url) => {
    calls.push(url); return Response.json({ sources: [camera, { id: 'fi-test', lat: 60, lon: 25, credit: 'Unrelated provider' }] });
  } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  assert.equal(calls[0], '/api/cctv/sources'); assert.equal(layer.getStats().count, 2);
  layer.setLocalArea({ lat: 51.046, lon: -114.063, radiusKm: 10 }); await layer.update(viewer);
  assert.equal(layer.getStats().count, 1); assert.match(layer.getRowControls().info, /City of Calgary/);
  assert.doesNotMatch(layer.getRowControls().info, /Unrelated provider/); layer.destroy();
});

test('disabling or changing a camera area aborts and refuses a late response', async () => {
  for (const cancel of [(layer) => layer.disable(), (layer) => layer.setLocalArea({ lat: 50.85, lon: 4.351, radiusKm: 10 })]) {
    const viewer = globe(); let resolve, signal;
    const layer = createCamerasLayer({ fetchImpl: (_url, options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); } });
    layer.init(viewer); layer.enable();
    const pending = layer.update(viewer); cancel(layer); assert.equal(signal.aborted, true);
    resolve(Response.json({ sources: [camera] }));
    assert.equal(await pending, false); assert.equal(layer.getStats().count, 0); assert.equal(viewer.source, null);
    layer.destroy();
  }
});

test('cached provider ages and stale state describe catalog retrieval without inventing image observation times', async () => {
  const viewer = globe();
  const retrievedAt = new Date(Date.now() - 30_000).toISOString();
  const layer = createCamerasLayer({ fetchImpl: async () => Response.json({ sources: [camera], stale: true,
    providers: [{ retrievedAt, status: 'stale' }], coverage: { status: 'stale', note: 'Limited reviewed catalog coverage.' } }) });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  assert.equal(layer.getStats().stale, true); assert.ok(layer.getStats().sourceAgeMs >= 30_000);
  assert.equal(layer.getStats().observedAt, undefined); assert.match(layer.getStats().coverage, /Limited/);
  layer.destroy();
});

test('changing area immediately removes the prior scope and a failed replacement cannot restore it', async () => {
  const viewer = globe(); let fail = false;
  const layer = createCamerasLayer({ fetchImpl: async () => {
    if (fail) throw new Error('Synthetic offline');
    return Response.json({ sources: [camera], providers: [{ retrievedAt: new Date().toISOString() }],
      coverage: { status: 'ready', note: 'Reviewed Calgary cameras within 10 km.' } });
  } });
  layer.init(viewer); layer.setLocalArea({ lat: 51.046, lon: -114.063, radiusKm: 10 }); layer.enable();
  await layer.update(viewer); viewer.pick();
  assert.equal(layer.getStats().count, 1);
  layer.setLocalArea({ lat: 50.85, lon: 4.351, radiusKm: 10 });
  assert.equal(viewer.source, null); assert.equal(viewer.selectedEntity, undefined);
  assert.equal(layer.getStats().count, 0); assert.equal(layer.getStats().coverage, null);
  assert.equal(layer.getStats().status, null); assert.equal(layer.getStats().lastUpdate, null);
  assert.equal(layer.getStats().sourceAgeMs, null); assert.doesNotMatch(layer.getRowControls().info, /Calgary/);
  fail = true; assert.equal(await layer.update(viewer), false);
  assert.equal(viewer.source, null); assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().status, 'unavailable'); assert.equal(layer.getStats().stale, false);
  assert.match(layer.getStats().error, /Synthetic offline/); assert.doesNotMatch(layer.getRowControls().info, /Calgary/);
  layer.destroy();
});

test('a failed same-area refresh retains records with stale state and the original provider retrieval date', async (t) => {
  const viewer = globe(); let fail = false, clock = Date.parse('2026-10-11T10:00:00Z');
  t.mock.method(Date, 'now', () => clock);
  const retrievedAt = new Date(clock - 30_000).toISOString();
  const layer = createCamerasLayer({ fetchImpl: async () => {
    if (fail) throw new Error('Synthetic provider outage');
    return Response.json({ sources: [camera], providers: [{ retrievedAt }],
      coverage: { status: 'ready', note: 'Reviewed Calgary cameras within 10 km.' } });
  } });
  layer.init(viewer); layer.setLocalArea({ lat: 51.046, lon: -114.063, radiusKm: 10 }); layer.enable();
  await layer.update(viewer); const updatedAt = layer.getStats().lastUpdate;
  assert.equal(layer.getStats().sourceAgeMs, 30_000);
  fail = true; clock += 60_000; assert.equal(await layer.update(viewer), false);
  const stats = layer.getStats();
  assert.equal(viewer.source.length, 1); assert.equal(stats.count, 1);
  assert.equal(stats.lastUpdate, updatedAt); assert.equal(stats.sourceAgeMs, 90_000);
  assert.equal(stats.status, 'stale'); assert.equal(stats.stale, true); assert.equal(stats.degraded, true);
  assert.match(layer.getRowControls().info, /earlier reviewed camera records/); assert.match(layer.getRowControls().info, /City of Calgary/);
  layer.destroy();
});

test('same-scope camera replacement remaps selected/tracked records with corrected attribution and source age', async (t) => {
  const viewer = globe(); let time = Date.parse('2026-10-12T08:00:00Z'), credit = 'First source credit';
  t.mock.method(Date, 'now', () => time);
  const layer = createCamerasLayer({ fetchImpl: async () => Response.json({ sources: [{ ...camera, credit }],
    providers: [{ retrievedAt: new Date(time - 30_000).toISOString() }] }) });
  layer.init(viewer); layer.enable(); assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.entities.values.length, 0); assert.equal(viewer.dataSources.length, 0);
  const selected = viewer.pick(); assert.ok(selected); viewer.trackedEntity = selected;
  time += 60_000; credit = 'Corrected source credit'; assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.selectedEntity.id, selected.id);
  assert.equal(viewer.trackedEntity, viewer.selectedEntity);
  assert.equal(viewer.selectedEntity.properties.credit.getValue(), credit);
  assert.match(layer.getRowControls().info, /Corrected source credit/);
  assert.equal(layer.getStats().sourceAgeMs, 30_000); assert.equal(viewer.scene.primitives.length, 1);
  assert.equal(viewer.entities.values.length, 0); assert.equal(viewer.dataSources.length, 0); layer.destroy();
});
