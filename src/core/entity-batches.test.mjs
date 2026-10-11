import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { stageEntities, replaceEntities } from './entity-batches.js';

test('a canceled preparation never publishes partial points or replaces existing data', async () => {
  const collection = new Cesium.EntityCollection();
  collection.add({ id: 'existing' });
  const controller = new AbortController();
  await assert.rejects(async () => {
    const entities = await stageEntities(Array.from({ length: 1000 }, (_, id) => id), (id) => {
      if (id === 129) controller.abort();
      return new Cesium.Entity({ id: String(id) });
    }, controller.signal);
    replaceEntities(collection, entities);
  }, { name: 'AbortError' });
  assert.deepEqual(collection.values.map((entity) => entity.id), ['existing']);
});

test('a complete bulk replacement emits one notification to the scene', async () => {
  const collection = new Cesium.EntityCollection(); collection.add({ id: 'old' });
  let notifications = 0;
  collection.collectionChanged.addEventListener(() => notifications++);
  replaceEntities(collection, await stageEntities([1, 2, 3], (id) => new Cesium.Entity({ id: String(id) })));
  assert.equal(notifications, 1);
  assert.deepEqual(collection.values.map((entity) => entity.id), ['1', '2', '3']);
});
