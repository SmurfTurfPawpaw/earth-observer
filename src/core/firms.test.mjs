import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { firmsProxy } from '../../server/providers/firms.js';
import { createFireDetectionsLayer } from './firms.js';
import { createSceneWork } from './scene-work.js';

function globe() {
  const primitives = new Cesium.PrimitiveCollection(), actions = new Map(); let picked, cameraMoves = 0;
  return { dataSources: new Cesium.DataSourceCollection(), entities: new Cesium.EntityCollection(),
    scene: { primitives, requestRender() {}, pick: () => picked }, camera: { flyTo() { cameraMoves++; } }, isDestroyed: () => false,
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (fn, type) => actions.set(type, fn), removeInputAction: type => actions.delete(type) },
    get source() { return primitives.length ? primitives.get(primitives.length - 1) : null; }, get cameraMoves() { return cameraMoves; },
    pick(index = 0) {
      const point = this.source.get(index); picked = { id: point.id, primitive: point };
      actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cesium.Cartesian2() }); return this.selectedEntity;
    } };
}

test('keyless FIRMS returns real, dated archive metadata without touching upstream', async () => {
  const savedKey = process.env.FIRMS_MAP_KEY;
  const savedFetch = globalThis.fetch;
  delete process.env.FIRMS_MAP_KEY;
  globalThis.fetch = () => { throw new Error('Keyless requests must not fetch upstream'); };
  try {
    let handler;
    const plugin = firmsProxy();
    plugin.configureServer({ middlewares: { use(path, callback) { assert.equal(path, '/api/firms'); handler = callback; } } });
    async function request(url) {
      let status, payload;
      await handler({ url }, {
        headersSent: false,
        writeHead(code) { status = code; },
        end(body) { payload = JSON.parse(body); },
      });
      return { status, payload };
    }
    const { status, payload } = await request('/');
    assert.equal(status, 200);
    assert.equal(payload.snapshot, true);
    assert.equal(payload.stale, true);
    assert.equal(payload.mode, 'archived-sample');
    assert.equal(payload.observationDate, '2026-07-16');
    assert.equal(payload.count, payload.fires.length);
    assert.ok(payload.count > 0);
    assert.match(payload.coverage, /not current|not.*comprehensive/);
    const health = await request('/status');
    assert.equal(health.payload.hasKey, false);
    assert.equal(health.payload.snapshot, true);
    assert.equal(health.payload.observationDate, payload.observationDate);
  } finally {
    if (savedKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
});

test('canceling queued fire preparation preserves its exact dated cohort and lazily selected source details', async () => {
  const archive = JSON.parse(await readFile(new URL('../data/local_data/firms/snapshot.json', import.meta.url), 'utf8'));
  const viewer = globe();
  let payload = { ...archive, fires: archive.fires.slice(0, 1) };
  const layer = createFireDetectionsLayer({ source: { getSnapshot: async () => payload } });
  layer.init(viewer); layer.enable(); assert.equal(await layer.update(viewer), true);
  const accepted = layer.getStats(), previous = viewer.source, entity = viewer.pick(); viewer.trackedEntity = entity;
  assert.equal(viewer.dataSources.length, 0); assert.equal(viewer.entities.values.length, 0);
  const queued = Promise.withResolvers();
  const scheduler = createSceneWork({ schedule() { queued.resolve(); return 1; }, cancelSchedule() {} });
  payload = { snapshot: false, mode: 'live', fires: archive.fires.slice(0, 2), lastObservationAt: Date.now() };
  const controller = new AbortController(), work = scheduler.scope({ key: 'cancel-fire-preparation', signal: controller.signal });
  const pending = layer.update(viewer, { signal: controller.signal, work });
  await queued.promise; controller.abort(); assert.equal(await pending, false); work.finish('cancelled'); scheduler.destroy();
  const retained = layer.getStats();
  assert.equal(viewer.scene.primitives.length, 1); assert.equal(viewer.source, previous);
  assert.equal(viewer.selectedEntity, entity); assert.equal(viewer.trackedEntity, entity);
  for (const key of ['count', 'totalCount', 'lastUpdate', 'observedAtMs', 'snapshot', 'observationDate', 'coverage', 'mode'])
    assert.equal(retained[key], accepted[key], key);
  layer.destroy(); assert.equal(viewer.scene.primitives.length, 0);
});

test('the dated FIRMS archive renders every real detection without an error or camera motion', async () => {
  const archive = JSON.parse(await readFile(new URL('../data/local_data/firms/snapshot.json', import.meta.url), 'utf8'));
  let payload = archive;
  const viewer = globe();
  const layer = createFireDetectionsLayer({ source: { getSnapshot: async () => payload } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.count, 45);
  assert.equal(stats.snapshot, true);
  assert.equal(stats.observationDate, '2026-07-16');
  assert.equal(stats.error, null);
  assert.match(stats.coverage, /not current/);
  assert.equal(viewer.source.length, 45);
  assert.equal(viewer.dataSources.length, 0); assert.equal(viewer.entities.values.length, 0);
  const selected = viewer.pick(); assert.ok(selected);
  assert.equal(selected.position.isConstant, true);
  assert.equal(selected.properties.dataMode.getValue(), 'Archived sample; not current conditions');
  assert.equal(viewer.cameraMoves, 0);
  layer.setParams({ focusDetections: true });
  assert.equal(viewer.cameraMoves, 1);
  payload = { snapshot: false, mode: 'live', stale: false, fires: [archive.fires[0]], fetchedAt: Date.now() };
  await layer.update(viewer);
  assert.equal(layer.getStats().snapshot, false);
  assert.equal(layer.getStats().observationDate, null);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy(); assert.equal(viewer.scene.primitives.length, 0);
});
