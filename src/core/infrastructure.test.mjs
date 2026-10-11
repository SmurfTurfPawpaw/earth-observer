import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { createInfrastructureLayer } from './infrastructure.js';
import { createInfrastructureSource, INFRASTRUCTURE_DATA_URLS, parseGeojsonLines, featurePoint } from '../sources/infrastructureData.js';

function scene() {
  const sources = new Set(); let cameraMoves = 0;
  const viewer = {
    dataSources: { add: (source) => sources.add(source), remove: (source) => sources.delete(source) },
    scene: { requestRender() {} }, camera: { flyTo() { cameraMoves++; } }, isDestroyed: () => false,
  };
  return { viewer, sources, cameraMoves: () => cameraMoves };
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
    const collection = [...env.sources][0].entities; let notifications = 0;
    collection.collectionChanged.addEventListener(() => notifications++);
    assert.equal(await layer.update(env.viewer), true);
    assert.equal(layer.getStats().count, expected);
    assert.equal(collection.values.length, expected);
    assert.equal(notifications, 1);
    assert.equal(env.cameraMoves(), 0);
    assert.ok(expected > 0);
    if (id === 'local-datacenters') assert.ok(expected > 1000, 'No former point-count cap may drop most records');
    for (const entity of collection.values) {
      const position = entity.position.getValue(Cesium.JulianDate.now());
      assert.ok(Math.abs(Cesium.Cartographic.fromCartesian(position).height) < 0.00001);
      assert.equal(entity.position.isConstant, true);
      assert.equal(entity.polyline, undefined);
      assert.equal(entity.polygon, undefined);
      assert.equal(entity.path, undefined);
      assert.equal(entity.point.disableDepthTestDistance, undefined);
      assert.match(entity.properties.credit.getValue(), /OpenStreetMap contributors/);
    }
    const approximate = collection.values.find((entity) => entity.properties.positionMeaning.getValue().startsWith('Approximate'));
    assert.ok(approximate);
    assert.match(approximate.properties.positionMeaning.getValue(), /not a surveyed point/);
    if (id === 'local-datacenters') {
      const aws = collection.values.find((entity) => entity.name === 'AWS');
      assert.equal(aws.properties.operator.getValue(), 'Amazon Web Services');
    } else {
      const itaipu = collection.values.find((entity) => entity.name === 'Usina Hidrelétrica de Itaipu');
      assert.equal(itaipu.properties.operator.getValue(), 'Itaipú Binacional');
      assert.equal(itaipu.properties.reportedElectricityOutput.getValue(), '14000 MW');
    }
    const firstEntity = collection.values[0];
    layer.disable(); layer.enable();
    notifications = 0;
    assert.equal(await layer.update(env.viewer), false);
    assert.equal(collection.values[0], firstEntity);
    assert.equal(notifications, 0);
    assert.equal(requests, 1);
    assert.equal(layer.updateInterval, 0);
    layer.destroy(); assert.equal(env.sources.size, 0);
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
  assert.equal([...env.sources][0].entities.values.length, 0);
  layer.enable(); assert.equal(await layer.update(env.viewer), true);
  assert.equal(requests, 2);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});
