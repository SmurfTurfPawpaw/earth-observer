import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createGdacsNoticesLayer } from './index.js';
import { gdacsNoticeSelection } from '../../core/gdacs-dossier.js';
import { canonicalDiscoveryRecord } from '../../core/discovery-index.js';
import { createWorldSourceItem } from '../../core/world-model.js';
import { worldHash } from '../../core/world-identity.js';

const AT = '2026-10-12T03:30:00.000Z', PUBLISHED = '2026-10-12T03:30:01.000Z';
async function view({ episode = '1', unlocated = false, corrected = false, empty = false, cached = false } = {}) {
  const record = canonicalDiscoveryRecord({ id: `gdacs:FL:1001:${episode}`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report', category: 'disasters',
    title: corrected ? 'TEST ONLY corrected flood notice' : 'TEST ONLY flood notice', eventType: 'FL', alertLevel: 'Orange',
    url: `https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=${episode}`, ...(unlocated ? {} : { lat: corrected ? 51 : 50, lon: 4 }),
    observedAt: '2026-10-11T10:00:00.000Z', eventEndAt: '2026-10-11T11:00:00.000Z', updatedAt: '2026-10-12T02:00:00.000Z', retrievedAt: AT });
  const snapshotId = await worldHash(record), item = { ...await createWorldSourceItem(record, { snapshotId, capturedAt: AT, recordedAt: PUBLISHED }),
    origin: { snapshotId: 'a'.repeat(64), firstCapturedAt: AT, firstRecordedAt: PUBLISHED, validation: 'retained-revision-index-only', bodyValidated: false } };
  return { version: await worldHash([snapshotId, episode, empty]), source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    cohort: { sourceId: 'gdacs', snapshotId, bodySha256: 'b'.repeat(64), capturedAt: AT, publishedAt: PUBLISHED }, items: empty ? [] : [item],
    counts: { returned: empty ? 0 : 1, mapped: empty || unlocated ? 0 : 1, unmapped: empty || !unlocated ? 0 : 1 },
    coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, completeRetainedCohort: true, completeProviderArchive: false },
    operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false }, browserCache: cached ? 'STALE' : null,
    browserCachedAt: cached ? Date.now() - 1000 : null };
}
function harness(source, { documentRef = { hidden: false } } = {}) {
  const sources = []; let renders = 0;
  const viewer = { dataSources: { add: value => sources.push(value), remove: value => sources.splice(sources.indexOf(value), 1) },
    scene: { requestRender() { renders++; } }, camera: { flyTo() { throw new Error('GDACS inspection must not move the camera'); } },
    earthTime: { seek() { throw new Error('GDACS inspection must not change scene UTC'); } } };
  viewer._selectedEntityChanged = new Cesium.Event();
  Object.defineProperties(viewer, {
    selectedEntity: Object.getOwnPropertyDescriptor(Cesium.Viewer.prototype, 'selectedEntity'),
    selectedEntityChanged: Object.getOwnPropertyDescriptor(Cesium.Viewer.prototype, 'selectedEntityChanged'),
  });
  const layer = createGdacsNoticesLayer({ source, documentRef }); layer.init(viewer); layer.enable();
  return { layer, viewer, sources, get renders() { return renders; } };
}

test('unchanged and corrected episodes preserve selectable object identity and update the cited notice in place', async () => {
  let snapshot = await view(); const h = harness({ getSnapshot: async () => snapshot }); await h.layer.update();
  const entities = h.sources[0].entities, selected = entities.values[0], properties = selected.properties;
  entities.collectionChanged.addEventListener(Cesium.Viewer.prototype._onEntityCollectionChanged, h.viewer); h.viewer.selectedEntity = selected;
  const time = Cesium.JulianDate.now(); assert.equal(gdacsNoticeSelection(selected, time).kind, 'Flood · GDACS notice');
  assert.equal(selected.ellipse, undefined); assert.equal(selected.point.pixelSize.getValue(time), 12); assert.equal(selected.point.disableDepthTestDistance, undefined);
  assert.equal(h.layer.getRowControls().items.length, 1); assert.match(h.layer.getRowControls().items[0].detail, /Flood.*Indicative location/);
  assert.equal(h.layer.setParams(h.layer.getRowControls().items[0].params), true, 'mapped notices also expose the existing keyboard inspection action');
  const oldNotice = properties.getValue(time)._gdacsNotice; snapshot = structuredClone(snapshot); await h.layer.update();
  assert.equal(h.viewer.selectedEntity, selected); assert.equal(selected.properties, properties); assert.equal(properties.getValue(time)._gdacsNotice, oldNotice);
  snapshot = await view({ corrected: true }); await h.layer.update(); assert.equal(h.viewer.selectedEntity, selected); assert.equal(selected.properties, properties);
  assert.match(gdacsNoticeSelection(selected, time).title, /corrected/); assert.equal(properties.getValue(time)._gdacsNotice.item.revision, snapshot.items[0].revision);
  assert.equal(selected.position.getValue(time).equals(Cesium.Cartesian3.fromDegrees(4, 51)), true); assert.equal(properties.hasProperty('_worldEvent'), false);
  snapshot = await view({ empty: true }); await h.layer.update(); assert.equal(h.viewer.selectedEntity, undefined); assert.equal(entities.values.length, 0);
  assert.equal(h.layer.getStats().status, 'unknown'); assert.equal(h.layer.getStats().lastUpdate, Date.parse(PUBLISHED)); h.layer.destroy();
});

test('unknown geometry creates no pin, can be inspected without navigation, and keeps episode identity when geometry is corrected', async () => {
  let snapshot = await view({ unlocated: true }); const h = harness({ getSnapshot: async () => snapshot }); await h.layer.update();
  const entity = h.sources[0].entities.values[0]; assert.equal(entity.position, undefined); assert.equal(entity.point, undefined); assert.equal(entity.show, false);
  assert.equal(h.layer.getStats().count, 0); assert.equal(h.layer.getStats().snapshot, false); assert.equal(h.layer.getStats().sourceAgeMs, null); assert.equal(h.layer.getStats().checkedAt, null);
  assert.match(h.layer.getRowControls().info, /1 without a location.*freshness unknown/);
  assert.equal(h.layer.setParams({ inspectItem: snapshot.items[0].itemId }), true); assert.equal(h.viewer.selectedEntity, entity);
  assert.ok(gdacsNoticeSelection(entity, Cesium.JulianDate.now()));
  snapshot = await view(); await h.layer.update(); assert.equal(h.sources[0].entities.values[0], entity); assert.equal(h.viewer.selectedEntity, entity); assert.ok(entity.position); assert.ok(entity.point);
  snapshot = await view({ unlocated: true }); await h.layer.update(); assert.equal(h.sources[0].entities.values[0], entity); assert.equal(h.viewer.selectedEntity, entity); assert.equal(entity.position, undefined);
  h.layer.destroy();
});

test('separate episodes never merge and elapsed reported to-dates do not hide retained membership', async () => {
  const first = await view(), second = await view({ episode: '2' }); first.items.push(second.items[0]); first.counts = { returned: 2, mapped: 2, unmapped: 0 };
  const h = harness({ getSnapshot: async () => first }); await h.layer.update(); assert.equal(h.sources[0].entities.values.length, 2);
  assert.notEqual(h.sources[0].entities.values[0].id, h.sources[0].entities.values[1].id); assert.equal(h.layer.getStats().count, 2);
  h.layer.setLocalArea({ lat: 0, lon: 0, radiusKm: 10 }); await h.layer.update(); assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.sources[0].entities.values.length, 2, 'area filtering only changes visible indicative pins'); h.layer.destroy();
});

test('cached/fresh callbacks share caller ownership and cannot paint after history, hide, disable or destroy', async () => {
  for (const action of ['external', 'disable', 'destroy']) {
    const snapshot = await view(), owner = new AbortController(), began = Promise.withResolvers(), complete = Promise.withResolvers(); let cached;
    const h = harness({ getSnapshot: options => { cached = options.onCached; began.resolve(options.signal); return complete.promise; } });
    const pending = h.layer.update(h.viewer, { signal: owner.signal }); const signal = await began.promise;
    if (action === 'external') owner.abort(); else h.layer[action](); assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(); cached(snapshot); complete.resolve(snapshot);
    assert.equal(await pending, false); assert.equal(h.layer.getStats().count, 0); if (action !== 'destroy') h.layer.destroy();
  }
});

test('failed reads preserve a valid picked notice and dated evidence instead of erasing it or claiming current freshness', async () => {
  const snapshot = await view(); let fail = false;
  const h = harness({ getSnapshot: async () => { if (fail) throw new Error('TEST ONLY stored cohort unavailable'); return snapshot; } });
  await h.layer.update(); const selected = h.sources[0].entities.values[0]; h.viewer.selectedEntity = selected; fail = true;
  assert.equal(await h.layer.update(), false); assert.equal(h.viewer.selectedEntity, selected);
  const stats = h.layer.getStats(); assert.equal(stats.lastUpdate, Date.parse(PUBLISHED)); assert.equal(stats.status, 'unavailable'); assert.equal(stats.stale, true);
  assert.equal(stats.checkedAt, null); assert.equal(stats.observedAt, null); assert.equal(typeof stats.coverage, 'string'); h.layer.destroy(); assert.equal(h.sources.length, 0);
});

test('repeated notice activation re-presents the current selection without clear/reselect or stale inactive admission', async () => {
  let snapshot = await view(), reads = 0, mode = 'live';
  const documentRef = { hidden: false }, h = harness({ getSnapshot: async () => { reads++; return snapshot; } }, { documentRef });
  h.viewer.earthTime.getState = () => ({ mode });
  await h.layer.update();
  const entity = h.sources[0].entities.values[0], action = h.layer.getRowControls().items[0].params, events = [];
  let presentationOpen = false, appearances = 0, departures = 0;
  h.viewer._selectionIndicator = { viewModel: { animateAppear() { appearances++; }, animateDepart() { departures++; } } };
  h.viewer.selectedEntityChanged.addEventListener(selected => { events.push(selected); presentationOpen = Boolean(selected); });
  assert.equal(h.layer.setParams(action), true); assert.equal(presentationOpen, true);
  presentationOpen = false; // Opening Layers hides the dossier, preserving selection.
  assert.equal(h.viewer.selectedEntity, entity); assert.equal(h.layer.setParams(action), true);
  assert.equal(presentationOpen, true); assert.equal(events.length, 2); assert.equal(events.every(value => value === entity), true);
  assert.equal(appearances, 1); assert.equal(departures, 0); assert.equal(reads, 1);

  snapshot = await view({ corrected: true }); await h.layer.update();
  presentationOpen = false; assert.equal(h.layer.setParams(action), true); assert.equal(presentationOpen, true);
  assert.equal(gdacsNoticeSelection(events.at(-1), Cesium.JulianDate.now()).notice.item.revision, snapshot.items[0].revision);
  assert.equal(h.sources[0].entities.values[0], entity); assert.equal(appearances, 1); assert.equal(reads, 2);

  const emitted = events.length;
  documentRef.hidden = true; assert.equal(h.layer.setParams(action), false); documentRef.hidden = false;
  mode = 'history'; assert.equal(h.layer.setParams(action), false); mode = 'live';
  h.layer.disable(); assert.equal(h.layer.setParams(action), false); h.layer.enable();
  assert.equal(h.layer.setParams({ inspectItem: `item:${'a'.repeat(64)}` }), false);
  assert.equal(events.length, emitted); assert.equal(reads, 2);
  snapshot = await view({ empty: true }); await h.layer.update();
  assert.equal(h.layer.setParams(action), false, 'An old row cannot revive absent cohort membership');
  h.layer.destroy(); assert.equal(h.layer.setParams(action), false);
});
