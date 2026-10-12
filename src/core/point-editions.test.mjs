import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createStagedPointEdition } from './point-editions.js';

const CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK, DOUBLE = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
const nativeViewer = () => {
  const actions = new Map(), native = [], selectedEntityChanged = new Cesium.Event(), trackedEntityChanged = new Cesium.Event();
  let selectedEntity, trackedEntity, picked;
  const click = event => native.push(['click', event]), double = event => native.push(['double', event]);
  actions.set(CLICK, click); actions.set(DOUBLE, double);
  const viewer = { scene: { primitives: new Cesium.PrimitiveCollection(), requestRender() {}, pick: () => picked },
    selectedEntityChanged, trackedEntityChanged, isDestroyed: () => false,
    screenSpaceEventHandler: { getInputAction: type => actions.get(type), setInputAction: (action, type) => actions.set(type, action),
      removeInputAction: type => actions.delete(type) } };
  Object.defineProperties(viewer, {
    selectedEntity: { get: () => selectedEntity, set(value) { if (value !== selectedEntity) { selectedEntity = value; selectedEntityChanged.raiseEvent(value); } } },
    trackedEntity: { get: () => trackedEntity, set(value) { if (value !== trackedEntity) { trackedEntity = value; trackedEntityChanged.raiseEvent(value); } } },
  });
  return { viewer, native, click, double, actions,
    pick(point, type = CLICK) { picked = point ? { id: point.id, primitive: point } : null; actions.get(type)?.({ position: { x: 2, y: 3 } }); },
    foreign(token, type = CLICK) { picked = { id: token }; actions.get(type)?.({ position: { x: 4, y: 5 } }); } };
};
const color = Cesium.Color.fromCssColorString('#82b5e6'), outline = Cesium.Color.fromCssColorString('#162832');
const spec = ({ id, revision = 'A', lat = 50, lon = 4 }) => ({ id, name: `Source ${revision} ${id}`,
  position: Cesium.Cartesian3.fromDegrees(lon, lat, 10),
  point: { pixelSize: 7, color, outlineColor: outline, outlineWidth: 1 },
  properties: { revision, acquiredAt: '2026-10-12T06:00:00Z', frameUrl: '/api/cctv/frame/example', nested: { value: [1, 'fact'] } } });
const ready = fixture => { const edition = createStagedPointEdition({ viewer: fixture.viewer, name: 'fixture' }); edition.setVisible(true); return edition; };

test('a complete edition consists of native points and immutable source specs without per-record Entities', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy()); let captured;
  await edition.stage(Array.from({ length: 1200 }, (_, id) => ({ id: `point:${id}` })), spec, { commit(next) { captured = next; } });
  assert.equal(edition.count, 1200); assert.equal(edition.source.length, 1200); assert.equal(f.viewer.scene.primitives.length, 1);
  assert.equal(f.viewer.selectedEntity, undefined); assert.equal(f.viewer.trackedEntity, undefined);
  assert.deepEqual(captured, { count: 1200 }); assert.ok(Object.isFrozen(captured));
  const feature = edition.getFeature('point:1199'); assert.ok(Object.isFrozen(feature)); assert.ok(Object.isFrozen(feature.properties.nested.value));
  assert.equal(feature instanceof Cesium.Entity, false); assert.equal(edition.source.get(1199).id instanceof Cesium.Entity, false);
  assert.equal(edition.source.get(1199).id.id, feature.id); assert.equal(edition.source.show, true);
  assert.ok(edition.getMetrics().preparationMs >= 0); assert.ok(edition.getMetrics().attachmentMs >= 0); assert.ok(edition.getMetrics().commitMs >= 0);
});

test('native point picks lazily materialize exact selected/tracked Entities while ordinary native handlers remain delegates', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy());
  await edition.stage([{ id: 'camera:exact' }, { id: 'camera:second' }], spec);
  f.pick(edition.source.get(0)); const selected = f.viewer.selectedEntity;
  assert.ok(selected instanceof Cesium.Entity); assert.equal(selected.id, 'camera:exact'); assert.equal(selected.name, 'Source A camera:exact');
  assert.equal(selected.properties.frameUrl.getValue(), '/api/cctv/frame/example'); assert.equal(selected.properties.acquiredAt.getValue(), '2026-10-12T06:00:00Z');
  assert.ok(Cesium.Cartesian3.equals(selected.position.getValue(Cesium.JulianDate.now()), edition.getFeature(selected.id).position));
  assert.equal(selected.point, undefined); assert.equal(selected.billboard, undefined);
  f.pick(edition.source.get(0), DOUBLE); assert.equal(f.viewer.trackedEntity, selected);
  f.pick(edition.source.get(1)); assert.equal(f.viewer.selectedEntity.id, 'camera:second'); assert.equal(f.viewer.trackedEntity, selected);
  const foreign = new Cesium.Entity({ id: 'ordinary' }); f.foreign(foreign); f.foreign(foreign, DOUBLE); f.pick(null);
  assert.deepEqual(f.native.map(([kind]) => kind), ['click', 'double', 'click']);
});

test('same IDs preserve selected projection and refresh exact facts after source metadata; old tokens cannot reopen stale editions', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy());
  await edition.stage([{ id: 'same' }], spec); const previous = edition.source, stalePoint = previous.get(0);
  f.pick(stalePoint); f.pick(stalePoint, DOUBLE); const selected = f.viewer.selectedEntity;
  let metadata = 'A', selections = 0; const stop = f.viewer.selectedEntityChanged.addEventListener(() => selections++); t.after(stop);
  const dates = []; const stopProperties = selected.definitionChanged.addEventListener((_entity, property) => {
    if (property === 'properties') dates.push([metadata, selected.properties.revision.getValue()]);
  }); t.after(stopProperties);
  await edition.stage([{ id: 'same', revision: 'B', lat: 51 }], spec, { commit() { metadata = 'B'; } });
  assert.equal(f.viewer.selectedEntity, selected); assert.equal(f.viewer.trackedEntity, selected); assert.deepEqual(dates, [['B', 'B']]);
  assert.equal(selected.name, 'Source B same'); assert.equal(selections, 0, 'A background correction does not reopen or focus the selection panel');
  assert.equal(previous.isDestroyed(), true); f.pick(stalePoint); assert.equal(selections, 0); assert.equal(f.native.length, 0);
  f.pick(edition.source.get(0)); assert.equal(selections, 1, 'An explicit repeated pick can reopen the current selected feature');
  await edition.stage([{ id: 'replacement', revision: 'C' }], spec);
  assert.equal(f.viewer.selectedEntity, undefined); assert.equal(f.viewer.trackedEntity, undefined);
});

test('failed or cancelled cooperative preparation retains the complete display and source metadata without attaching partial points', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy());
  await edition.stage([{ id: 'same' }], spec); f.pick(edition.source.get(0)); const previous = edition.source, selected = f.viewer.selectedEntity;
  let attachments = 0, commits = 0; const stop = f.viewer.scene.primitives.primitiveAdded.addEventListener(() => attachments++); t.after(stop);
  const controller = new AbortController();
  await assert.rejects(edition.stage(Array.from({ length: 600 }, (_, id) => ({ id: String(id), revision: 'B' })), record => {
    if (record.id === '129') controller.abort(); return spec(record);
  }, { signal: controller.signal, commit() { commits++; } }), { name: 'AbortError' });
  assert.equal(edition.source, previous); assert.equal(previous.show, true); assert.equal(attachments, 0); assert.equal(commits, 0);
  assert.equal(f.viewer.selectedEntity, selected); assert.equal(selected.properties.revision.getValue(), 'A');
  await assert.rejects(edition.stage([{ id: 'bad' }], () => { throw new Error('projection failed'); }), /projection failed/);
  assert.equal(edition.source, previous); assert.equal(f.viewer.scene.primitives.length, 1);
});

test('late asynchronous attachment is discarded on cancellation and terminal destruction without replacing complete evidence', async () => {
  for (const terminal of [false, true]) {
    const f = nativeViewer(), edition = ready(f); await edition.stage([{ id: 'same' }], spec);
    const previous = edition.source, adding = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController();
    const add = f.viewer.scene.primitives.add.bind(f.viewer.scene.primitives); let commits = 0;
    f.viewer.scene.primitives.add = collection => { adding.resolve(collection); return gate.promise.then(() => add(collection)); };
    const pending = edition.stage([{ id: 'same', revision: 'B' }], spec, { signal: controller.signal, commit() { commits++; } });
    const next = await adding.promise; assert.equal(next.show, false); assert.equal(previous.show, true);
    if (terminal) edition.destroy(); else controller.abort();
    gate.resolve(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(commits, 0); assert.equal(next.isDestroyed(), true);
    assert.equal(f.viewer.scene.primitives.length, terminal ? 0 : 1);
    if (!terminal) assert.equal(edition.source, previous);
    edition.destroy(); assert.equal(f.viewer.scene.primitives.length, 0);
  }
});

test('a newer owner can complete while an older attachment retires and stale tokens never select the newer same-ID facts', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy()); await edition.stage([{ id: 'same' }], spec);
  const adding = Promise.withResolvers(), gate = Promise.withResolvers(), add = f.viewer.scene.primitives.add.bind(f.viewer.scene.primitives); let additions = 0;
  f.viewer.scene.primitives.add = collection => ++additions === 1 ? (adding.resolve(collection), gate.promise.then(() => add(collection))) : add(collection);
  const old = edition.stage([{ id: 'same', revision: 'B' }], spec); const oldFailure = assert.rejects(old, { name: 'AbortError' });
  const retired = await adding.promise, stalePoint = retired.get(0);
  await edition.stage([{ id: 'same', revision: 'C' }], spec); gate.resolve(); await oldFailure;
  assert.equal(retired.isDestroyed(), true); assert.equal(edition.getFeature('same').properties.revision, 'C');
  f.pick(stalePoint); assert.equal(f.viewer.selectedEntity, undefined); f.pick(edition.source.get(0));
  assert.equal(f.viewer.selectedEntity.properties.revision.getValue(), 'C'); assert.equal(f.viewer.scene.primitives.length, 1);
});

test('malformed, duplicate, Entity and asynchronous projections fail closed with the previous edition intact', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy()); await edition.stage([{ id: 'same' }], spec);
  const previous = edition.source;
  for (const project of [async record => spec(record), () => new Cesium.Entity({ id: 'bad' }), record => ({ ...spec(record), position: { x: NaN, y: 1, z: 2 } }),
    record => ({ ...spec(record), properties: { invalid: Infinity } })])
    await assert.rejects(edition.stage([{ id: 'bad' }], project), TypeError);
  await assert.rejects(edition.stage([{ id: 'duplicate' }, { id: 'duplicate' }], spec), /unique IDs/);
  assert.equal(edition.source, previous); assert.equal(edition.count, 1); assert.equal(f.viewer.scene.primitives.length, 1);
});

test('throwing projection and removal observers cannot discard a complete accepted replacement', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy()); await edition.stage([{ id: 'same' }], spec); f.pick(edition.source.get(0));
  const selected = f.viewer.selectedEntity; let revision = 'A';
  const stopProjection = selected.definitionChanged.addEventListener(() => { assert.equal(revision, 'B'); throw new Error('observer failed'); });
  const stopRemoval = f.viewer.scene.primitives.primitiveRemoved.addEventListener(() => { throw new Error('removal failed'); });
  assert.equal(await edition.stage([{ id: 'same', revision: 'B', lat: 51 }], spec, { commit() { revision = 'B'; } }), true);
  assert.equal(edition.source.show, true); assert.equal(f.viewer.scene.primitives.length, 1); assert.equal(selected.properties.revision.getValue(), 'B');
  assert.equal(selected.name, 'Source B same'); assert.ok(edition.getMetrics().observerErrors >= 2);
  stopProjection(); stopRemoval();
});

test('disable, scope clear and destroy revoke selected/tracked ownership even when selection observers throw', async () => {
  for (const action of ['disable', 'clear', 'destroy']) {
    const f = nativeViewer(), edition = ready(f); await edition.stage([{ id: 'same' }], spec); const point = edition.source.get(0);
    f.pick(point); f.pick(point, DOUBLE);
    const stop = f.viewer.selectedEntityChanged.addEventListener(() => { throw new Error('observer failed'); });
    if (action === 'disable') edition.setVisible(false); else edition[action]();
    assert.equal(f.viewer.selectedEntity, undefined); assert.equal(f.viewer.trackedEntity, undefined); f.pick(point);
    assert.equal(f.viewer.selectedEntity, undefined);
    if (action === 'disable') assert.equal(edition.source.show, false);
    else assert.equal(edition.count, 0);
    stop(); edition.destroy(); assert.equal(f.viewer.scene.primitives.length, 0);
    await assert.rejects(edition.stage([{ id: 'late' }], spec), { name: 'AbortError' });
  }
});

test('one refcounted bridge serves multiple editions and teardown restores only handlers it still owns', async () => {
  const f = nativeViewer(), first = ready(f), wrapper = f.actions.get(CLICK), second = ready(f);
  assert.equal(f.actions.get(CLICK), wrapper); await first.stage([{ id: 'one' }], spec); await second.stage([{ id: 'two' }], spec);
  first.destroy(); assert.equal(f.actions.get(CLICK), wrapper); f.pick(second.source.get(0)); assert.equal(f.viewer.selectedEntity.id, 'two');
  second.destroy(); assert.equal(f.actions.get(CLICK), f.click); assert.equal(f.actions.get(DOUBLE), f.double);
  const another = ready(f), laterOwner = () => {}; f.actions.set(CLICK, laterOwner); another.destroy();
  assert.equal(f.actions.get(CLICK), laterOwner); assert.equal(f.actions.get(DOUBLE), f.double);
});

test('a newer owner can decorate the bridge and retain ordinary native picking after final retirement', () => {
  const f = nativeViewer(), edition = ready(f), previous = f.actions.get(CLICK);
  const decorator = event => previous(event); f.actions.set(CLICK, decorator);
  edition.destroy(); assert.equal(f.actions.get(CLICK), decorator);
  f.foreign(new Cesium.Entity({ id: 'ordinary' })); assert.equal(f.native.length, 1); assert.equal(f.native[0][0], 'click');
  f.viewer.isDestroyed = () => true; f.foreign(new Cesium.Entity({ id: 'closed' })); assert.equal(f.native.length, 1);
});

test('a throwing native attachment observer rejects the candidate and cleans its accepted primitive membership', async t => {
  const f = nativeViewer(), edition = ready(f); t.after(() => edition.destroy()); await edition.stage([{ id: 'same' }], spec);
  const previous = edition.source;
  const stop = f.viewer.scene.primitives.primitiveAdded.addEventListener(() => { throw new Error('attachment observer failed'); });
  await assert.rejects(edition.stage([{ id: 'same', revision: 'B' }], spec), /attachment observer failed/); stop();
  assert.equal(edition.source, previous); assert.equal(edition.getFeature('same').properties.revision, 'A');
  assert.equal(f.viewer.scene.primitives.length, 1); assert.equal(previous.show, true);
});
