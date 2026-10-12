import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { stageEntities, replaceEntities, createStagedEntityEdition } from './entity-batches.js';

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

const viewerFixture = () => ({ dataSources: new Cesium.DataSourceCollection(),
  scene: { requestRender() {} }, isDestroyed: () => false });
const mappedEntity = record => new Cesium.Entity({ id: record.id, properties: { revision: record.revision } });

test('a complete hidden cohort attaches before exact metadata and selected/tracked identities swap', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' });
  edition.setVisible(true); let revision = 'A';
  await edition.stage([{ id: 'same', revision }], mappedEntity);
  const previous = edition.source, first = previous.entities.getById('same');
  viewer.selectedEntity = first; viewer.trackedEntity = first;
  const attached = [];
  viewer.dataSources.dataSourceAdded.addEventListener((_collection, source) => {
    attached.push({ shown: source.show, count: source.entities.values.length, prior: previous.show });
  });
  assert.equal(await edition.stage([{ id: 'same', revision: 'B' }, { id: 'new', revision: 'B' }], mappedEntity, {
    commit() { revision = 'B'; },
  }), true);
  assert.deepEqual(attached, [{ shown: false, count: 2, prior: true }]);
  assert.equal(revision, 'B'); assert.equal(viewer.dataSources.length, 1);
  assert.notEqual(viewer.selectedEntity, first);
  assert.equal(viewer.selectedEntity, edition.source.entities.getById('same'));
  assert.equal(viewer.trackedEntity, viewer.selectedEntity);
  assert.equal(viewer.selectedEntity.properties.revision.getValue(), revision);
  assert.ok(edition.getMetrics().preparationMs >= 0); assert.ok(edition.getMetrics().commitMs >= 0);
  edition.destroy(); assert.equal(viewer.dataSources.length, 0);
});

test('canceled sliced construction retains the previous complete cohort and never attaches partial evidence', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const previous = edition.source, controller = new AbortController(); let commits = 0, attachments = 0;
  viewer.selectedEntity = previous.entities.getById('same');
  viewer.dataSources.dataSourceAdded.addEventListener(() => attachments++);
  await assert.rejects(edition.stage(Array.from({ length: 500 }, (_, i) => ({ id: String(i), revision: 'B' })), record => {
    if (record.id === '129') controller.abort();
    return mappedEntity(record);
  }, { signal: controller.signal, commit() { commits++; } }), { name: 'AbortError' });
  assert.equal(edition.source, previous); assert.equal(previous.show, true);
  assert.equal(viewer.selectedEntity, previous.entities.getById('same'));
  assert.equal(viewer.dataSources.length, 1); assert.equal(attachments, 0); assert.equal(commits, 0);
  edition.destroy();
});

test('cancellation during native attachment discards the late hidden source without publishing new metadata', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const previous = edition.source, controller = new AbortController(), gate = Promise.withResolvers(), adding = Promise.withResolvers();
  const add = viewer.dataSources.add.bind(viewer.dataSources); let commits = 0;
  viewer.dataSources.add = source => { adding.resolve(source); return gate.promise.then(() => add(source)); };
  const next = edition.stage([{ id: 'same', revision: 'B' }], mappedEntity, { signal: controller.signal, commit() { commits++; } });
  const hidden = await adding.promise;
  assert.equal(hidden.show, false); assert.equal(previous.show, true); assert.equal(viewer.dataSources.length, 1);
  controller.abort(); gate.resolve();
  await assert.rejects(next, { name: 'AbortError' });
  assert.equal(viewer.dataSources.length, 1); assert.equal(edition.source, previous); assert.equal(commits, 0);
  edition.destroy();
});

test('destroy while native attachment is pending cleans both current and late sources', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const gate = Promise.withResolvers(), adding = Promise.withResolvers(), add = viewer.dataSources.add.bind(viewer.dataSources);
  viewer.dataSources.add = source => { adding.resolve(); return gate.promise.then(() => add(source)); };
  const pending = edition.stage([{ id: 'same', revision: 'B' }], mappedEntity);
  await adding.promise; edition.destroy(); assert.equal(viewer.dataSources.length, 0); gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(viewer.dataSources.length, 0);
});

test('a failed entity constructor never clears the existing selection or accepted source revision', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const previous = edition.source; viewer.selectedEntity = previous.entities.getById('same');
  await assert.rejects(edition.stage([{ id: 'bad' }], () => { throw new Error('Invalid entity'); }), /Invalid entity/);
  assert.equal(edition.source, previous); assert.equal(viewer.dataSources.length, 1);
  assert.equal(viewer.selectedEntity, previous.entities.getById('same')); edition.destroy();
});

test('throwing selection/removal observers cannot discard an already accepted complete edition', async () => {
  const viewer = viewerFixture(), selectedChanged = new Cesium.Event(); let selected;
  Object.defineProperty(viewer, 'selectedEntity', { get: () => selected, set(value) { selected = value; selectedChanged.raiseEvent(value); } });
  const edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  viewer.selectedEntity = edition.source.entities.getById('same'); let revision = 'A';
  const removeSelection = selectedChanged.addEventListener(() => { assert.equal(revision, 'B'); throw new Error('Observer failed'); });
  const removeRemoval = viewer.dataSources.dataSourceRemoved.addEventListener(() => { throw new Error('Removal observer failed'); });
  assert.equal(await edition.stage([{ id: 'same', revision: 'B' }], mappedEntity, { commit() { revision = 'B'; } }), true);
  assert.equal(edition.source.show, true); assert.equal(viewer.dataSources.length, 1);
  assert.equal(viewer.selectedEntity, edition.source.entities.getById('same'));
  assert.equal(viewer.selectedEntity.properties.revision.getValue(), revision);
  assert.equal(edition.getMetrics().observerErrors, 2);
  removeSelection(); removeRemoval(); edition.destroy();
});

test('a newer staged edition fences and releases an older pending cohort before its late attachment', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const gate = Promise.withResolvers(), adding = Promise.withResolvers(), add = viewer.dataSources.add.bind(viewer.dataSources);
  let calls = 0, revision = 'A';
  viewer.dataSources.add = source => ++calls === 1 ? (adding.resolve(source), gate.promise.then(() => add(source))) : add(source);
  const older = edition.stage([{ id: 'same', revision: 'B' }], mappedEntity, { commit() { revision = 'B'; } });
  const retired = await adding.promise;
  const newer = edition.stage([{ id: 'same', revision: 'C' }], mappedEntity, { commit() { revision = 'C'; } });
  assert.equal(retired.entities.values.length, 0, 'Retired off-scene entity storage is released immediately');
  assert.equal(await newer, true); gate.resolve(); await assert.rejects(older, { name: 'AbortError' });
  assert.equal(viewer.dataSources.length, 1); assert.equal(revision, 'C');
  assert.equal(edition.source.entities.getById('same').properties.revision.getValue(), 'C'); edition.destroy();
});

test('throwing selection observers do not interrupt disable, scope clearing or teardown', async () => {
  for (const action of ['disable', 'clear', 'destroy']) {
    const viewer = viewerFixture(), changed = new Cesium.Event(); let selected;
    Object.defineProperty(viewer, 'selectedEntity', { get: () => selected, set(value) { selected = value; changed.raiseEvent(value); } });
    const edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
    await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
    viewer.selectedEntity = edition.source.entities.getById('same'); viewer.trackedEntity = viewer.selectedEntity;
    const remove = changed.addEventListener(() => { throw new Error('Selection observer failed'); });
    if (action === 'disable') edition.setVisible(false);
    else edition[action]();
    assert.equal(viewer.selectedEntity, undefined); assert.equal(viewer.trackedEntity, undefined);
    if (action === 'disable') assert.equal(edition.source.show, false);
    if (action === 'clear') assert.equal(edition.source.entities.values.length, 0);
    if (action === 'destroy') assert.equal(viewer.dataSources.length, 0);
    remove(); edition.destroy(); assert.equal(viewer.dataSources.length, 0);
  }
});

test('an async entity mapper is rejected before attachment instead of publishing empty or incomplete records', async () => {
  const viewer = viewerFixture(), edition = createStagedEntityEdition({ viewer, name: 'fixture' }); edition.setVisible(true);
  await edition.stage([{ id: 'same', revision: 'A' }], mappedEntity);
  const previous = edition.source;
  await assert.rejects(edition.stage([{ id: 'bad', revision: 'B' }], async record => mappedEntity(record)), /must be synchronous/);
  assert.equal(edition.source, previous); assert.equal(viewer.dataSources.length, 1); edition.destroy();
});

test('a complete bulk replacement emits one notification to the scene', async () => {
  const collection = new Cesium.EntityCollection(); collection.add({ id: 'old' });
  let notifications = 0;
  collection.collectionChanged.addEventListener(() => notifications++);
  replaceEntities(collection, await stageEntities([1, 2, 3], (id) => new Cesium.Entity({ id: String(id) })));
  assert.equal(notifications, 1);
  assert.deepEqual(collection.values.map((entity) => entity.id), ['1', '2', '3']);
});
