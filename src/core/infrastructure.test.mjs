import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { createInfrastructureLayer } from './infrastructure.js';
import { createInfrastructureSource, INFRASTRUCTURE_DATA_URLS, parseGeojsonLines, featurePoint } from '../sources/infrastructureData.js';

function scene() {
  const primitives = new Cesium.PrimitiveCollection(), actions = new Map(); let cameraMoves = 0, picked;
  const viewer = {
    dataSources: new Cesium.DataSourceCollection(), entities: new Cesium.EntityCollection(),
    scene: { primitives, requestRender() {}, pick: () => picked }, camera: { flyTo() { cameraMoves++; } }, isDestroyed: () => false,
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (fn, type) => actions.set(type, fn), removeInputAction: type => actions.delete(type) },
    get source() { return primitives.length ? primitives.get(primitives.length - 1) : null; },
    pick(index = 0) {
      const point = this.source.get(index); picked = { id: point.id, primitive: point };
      actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cesium.Cartesian2() }); return this.selectedEntity;
    },
  };
  return { viewer, primitives, cameraMoves: () => cameraMoves };
}

test('both bundled inventories render every valid feature as a static point with real metadata and no invented height', async () => {
  for (const id of ['local-datacenters', 'local-dams']) {
    const text = await readFile(new URL(INFRASTRUCTURE_DATA_URLS[id]), 'utf8');
    const expected = parseGeojsonLines(text).filter((feature) => {
      const point = featurePoint(feature); return point && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
    }).length;
    assert.equal(expected, parseGeojsonLines(text).length, 'Every bundled feature has a usable representative point');
    const env = scene(); let requests = 0;
    const source = createInfrastructureSource({ fetchImpl: async () => { requests++; return { ok: true, text: async () => text }; } });
    const layer = createInfrastructureLayer({ id, source });
    layer.init(env.viewer); layer.enable();
    assert.equal(env.viewer.source, null);
    assert.equal(await layer.update(env.viewer), true);
    assert.equal(layer.getStats().count, expected);
    const collection = env.viewer.source;
    assert.equal(collection.length, expected);
    assert.equal(env.viewer.dataSources.length, 0); assert.equal(env.viewer.entities.values.length, 0, 'Static markers allocate no per-record Entity');
    assert.equal(env.cameraMoves(), 0);
    assert.ok(expected > 0);
    if (id === 'local-datacenters') assert.ok(expected > 1000, 'No former point-count cap may drop most records');
    for (let i = 0; i < collection.length; i++) {
      const point = collection.get(i), position = point.position;
      assert.ok(Math.abs(Cesium.Cartographic.fromCartesian(position).height) < 0.00001);
      assert.equal(point.disableDepthTestDistance, 0);
    }
    const records = await source.getRecords(id);
    const approximate = env.viewer.pick(records.findIndex(record => record.approximate));
    assert.ok(approximate);
    assert.match(approximate.properties.positionMeaning.getValue(), /not a surveyed point/);
    assert.match(approximate.properties.credit.getValue(), /OpenStreetMap contributors/);
    assert.equal(approximate.position.isConstant, true);
    assert.equal(approximate.polyline, undefined); assert.equal(approximate.polygon, undefined); assert.equal(approximate.path, undefined);
    if (id === 'local-datacenters') {
      const aws = env.viewer.pick(records.findIndex(record => record.name === 'AWS'));
      assert.equal(aws.properties.operator.getValue(), 'Amazon Web Services');
    } else {
      const itaipu = env.viewer.pick(records.findIndex(record => record.name === 'Usina Hidrelétrica de Itaipu'));
      assert.equal(itaipu.properties.operator.getValue(), 'Itaipú Binacional');
      assert.equal(itaipu.properties.reportedElectricityOutput.getValue(), '14000 MW');
    }
    const firstPoint = collection.get(0);
    layer.disable(); layer.enable();
    assert.equal(await layer.update(env.viewer), false);
    assert.equal(env.viewer.source, collection); assert.equal(collection.get(0), firstPoint);
    assert.equal(requests, 1);
    assert.equal(layer.updateInterval, 0);
    layer.destroy(); assert.equal(env.primitives.length, 0);
  }
});

test('hidden updates perform no fetch and disabling during body loading publishes neither points nor cache', async () => {
  const env = scene(), documentRef = { hidden: true };
  let requests = 0;
  const body = Promise.withResolvers(), reading = Promise.withResolvers();
  const fixture = JSON.stringify({ type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [4, 50] }, properties: { tags: { name: 'Mapped facility' } } });
  const source = createInfrastructureSource({ fetchImpl: async () => {
    requests++;
    return { ok: true, text: () => { reading.resolve(); return requests === 1 ? body.promise : Promise.resolve(fixture); } };
  } });
  const layer = createInfrastructureLayer({ id: 'local-datacenters', source, documentRef });
  layer.init(env.viewer); layer.enable();
  assert.equal(await layer.update(env.viewer), false);
  assert.equal(requests, 0);
  documentRef.hidden = false;
  const updating = layer.update(env.viewer);
  await reading.promise; layer.disable(); body.resolve(fixture);
  assert.equal(await updating, false);
  assert.equal(layer.getStats().count, 0);
  assert.equal(env.viewer.source, null);
  layer.enable(); assert.equal(await layer.update(env.viewer), true);
  assert.equal(requests, 2);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});
