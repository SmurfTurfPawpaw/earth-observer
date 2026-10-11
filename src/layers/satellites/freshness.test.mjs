import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { createSatelliteSource, satelliteSourceMetadata, isSatelliteElementSupported, satelliteElementEpochMs,
  satelliteProvenance, MAX_ELEMENT_AGE_MS, MAX_ELEMENT_FUTURE_MS } from './source.js';
import { createState } from './state.js';
import { createControls } from './controls.js';
import { createOrbits } from './orbits.js';
import { createIngestion } from './ingestion.js';
import { createCatalog } from './catalog.js';
import { createRendering } from './rendering.js';
import { createTracking } from './tracking.js';
import { createLabels } from './labels.js';
import { createRecords } from './records.js';
import { createLifecycle } from './lifecycle.js';

const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const satrec = () => twoline2satrec(L1, L2);
const EPOCH = satelliteElementEpochMs({ satrec: satrec() });
const CLOCK = EPOCH + 3 * 3600000;
const RETRIEVED = CLOCK - 1800000;
const noop = () => {};
function tle(id = 40000, epoch = '08264.51782528') {
  return `TEST-${id}\n${L1.replace('25544', String(id)).replace('08264.51782528', epoch)}\n${L2.replace('25544', String(id))}\n`;
}
function response(text, cacheStatus = 'HIT', retrievedAt = RETRIEVED) {
  return new Response(text, { headers: { 'x-tle-cache': cacheStatus,
    ...(retrievedAt === null ? {} : { 'x-feed-retrieved-at': new Date(retrievedAt).toISOString() }) } });
}
function harness() {
  let clock = CLOCK, fail = false, body = tle(), denseBody = tle(40001);
  const services = {
    now: () => clock,
    overlays: { setOverlayEntries: noop, setOverlaySourceVisible: noop, clearOverlaySource: noop },
    focus: { focusNowMs: (at) => at, getFocusTarget: () => null,
      focusPassIsNeeded: () => false, clearFocusTarget: noop, publishFocusTargetFromCachedPosition: noop },
    context: { clearTrackedSubjectContext: noop, getContextStore: () => ({ entities: new Map(), selectedEntityId: null }),
      refreshTrackedSubjectContext: noop, selectTrackedSubjectContext: noop },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
    layerState: { isExplicitLayerStateOrigin: () => false },
    readout: { refreshTrackedReadout: noop },
  };
  const state = createState({ services });
  const viewer = { scene: { frameState: { frameNumber: 1 }, primitives: { add: (value) => value, remove: noop },
    preRender: { addEventListener: () => noop } }, entities: { add: (value) => ({ ...value }), remove: noop }, camera: {} };
  state._viewer = viewer;
  state._enabled = true;
  state._pointCollection = { show: true, removeAll: noop, remove: noop, add: (value) => ({ show: true, ...value }) };
  const source = createSatelliteSource({ now: () => clock, fetchImpl: async (url) => fail
    ? new Response('unavailable', { status: 503 }) : response(url.endsWith('starlink') ? denseBody : body) });
  const parts = {}, context = { state, services, parts, source };
  parts.controls = createControls(context);
  parts.orbits = createOrbits(context);
  let propagations = 0;
  const propagate = parts.orbits.propagatePosition;
  parts.orbits.propagatePosition = (...args) => { propagations++; return propagate(...args); };
  parts.labels = createLabels(context);
  parts.tracking = createTracking(context);
  parts.rendering = createRendering(context);
  parts.catalog = createCatalog(context);
  parts.records = createRecords(context);
  parts.lifecycle = createLifecycle(context);
  parts.interaction = { _installClickHandler: noop };
  parts.ingestion = createIngestion(context);
  return { state, parts, viewer, source, services, get propagations() { return propagations; },
    setClock: (value) => { clock = value; }, setFail: (value) => { fail = value; },
    setBody: (value) => { body = value; }, setDenseBody: (value) => { denseBody = value; } };
}

test('satellite transport retains original retrieval and handles both stale proxy markers', async () => {
  for (const marker of ['HIT', 'MISS', 'STALE', 'STALE-ERROR']) {
    const source = createSatelliteSource({ now: () => CLOCK, fetchImpl: async () => response(tle(), marker) });
    const value = await source.readGroup('stations');
    assert.equal(value.retrievedAt, new Date(RETRIEVED).toISOString());
    assert.equal(value.ageMs, CLOCK - RETRIEVED);
    assert.equal(value.cacheStatus, marker);
    assert.equal(value.stale, marker.startsWith('STALE'));
  }
  const old = createSatelliteSource({ now: () => CLOCK, fetchImpl: async () => response(tle(), 'HIT', CLOCK - 6 * 3600000) });
  assert.equal((await old.readGroup('visual')).stale, true);
  const unknown = createSatelliteSource({ now: () => CLOCK, fetchImpl: async () => new Response(tle(), {
    headers: { 'x-tle-cache': 'HIT', 'x-feed-age-ms': '120000', age: '20' } }) });
  const missing = await unknown.readGroup('stations');
  assert.equal(missing.retrievedAt, null);
  assert.equal(missing.ageMs, 140000);
  assert.equal(missing.stale, true);
  const unknownProvenance = satelliteProvenance({ source: satelliteSourceMetadata(missing, 'stations') }, CLOCK + 1000);
  assert.equal(unknownProvenance.sourceRetrievedAt, null);
  assert.equal(unknownProvenance.sourceAgeMs, 141000);
  assert.equal(unknownProvenance.sourceStatus, 'unknown');
  const offline = createSatelliteSource({ now: () => CLOCK, fetchImpl: async () => {
    const value = response(tle()); value.headers.set('x-browser-cache', 'OFFLINE'); return value;
  } });
  const cached = await offline.readGroup('stations');
  assert.equal(cached.stale, true);
  assert.equal(cached.cacheStatus, 'HIT');
  assert.equal(cached.browserCacheStatus, 'OFFLINE');
  assert.equal(cached.retrievedAt, new Date(RETRIEVED).toISOString());
});

test('element admission is finite and independent of a newly retrieved source', () => {
  const satellite = { satrec: satrec(), source: { retrievedAt: new Date(CLOCK).toISOString(), cacheStatus: 'MISS' } };
  assert.equal(isSatelliteElementSupported(satellite, CLOCK), true);
  assert.equal(isSatelliteElementSupported(satellite, EPOCH + MAX_ELEMENT_AGE_MS - 1), true);
  assert.equal(isSatelliteElementSupported(satellite, EPOCH + MAX_ELEMENT_AGE_MS), false);
  assert.equal(satelliteProvenance(satellite, EPOCH + MAX_ELEMENT_AGE_MS).elementStatus, 'expired');
  assert.equal(isSatelliteElementSupported(satellite, EPOCH - MAX_ELEMENT_FUTURE_MS), true);
  assert.equal(isSatelliteElementSupported(satellite, EPOCH - MAX_ELEMENT_FUTURE_MS - 1), false);
  assert.equal(satelliteProvenance(satellite, EPOCH - MAX_ELEMENT_FUTURE_MS - 1).elementStatus, 'future-epoch');
  for (const record of [null, {}, { satrec: {} }, { satrec: { jdsatepoch: NaN } }, { satrec: { jdsatepoch: 1e300 } }]) {
    assert.equal(isSatelliteElementSupported(record, CLOCK), false);
    assert.equal(satelliteProvenance(record, CLOCK).elementStatus, 'missing-epoch');
  }
});

test('cached ingestion and outages never relabel browser checks as source retrievals', async () => {
  const h = harness();
  await h.parts.ingestion.methods.update(h.viewer);
  const entry = h.state._catalog.get(40000);
  assert.equal(entry.source.retrievedAt, new Date(RETRIEVED).toISOString());
  assert.equal(entry.source.cacheStatus, 'HIT');
  assert.equal(h.parts.controls.methods.getStats().lastUpdate, RETRIEVED);
  const found = h.parts.controls.methods.findByQuery('40000');
  assert.equal(found.provenance.elementEpoch, new Date(EPOCH).toISOString());
  assert.equal(found.provenance.sourceRetrievedAt, new Date(RETRIEVED).toISOString());
  assert.equal(found.provenance.positionKind, 'SGP4 prediction');
  h.setClock(CLOCK + 3600000);
  await h.parts.ingestion.methods.update(h.viewer);
  assert.equal(h.parts.controls.methods.getStats().lastUpdate, RETRIEVED);
  assert.equal(h.parts.controls.methods.getStats().lastCheckedAt, CLOCK + 3600000);
  h.setFail(true);
  await h.parts.ingestion.methods.update(h.viewer);
  const stats = h.parts.controls.methods.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.stale, true);
  assert.equal(stats.lastUpdate, RETRIEVED);
  assert.ok(stats.sourceGroups.every((record) => record.available === false));
  assert.equal(h.parts.controls.methods.findByQuery('40000').provenance.sourceStatus, 'stale');
});

test('expired elements are withheld at ingestion even when proxy acquisition is recent', async () => {
  const h = harness();
  h.setBody(tle(40000) + tle(40002, '08254.51782528') + tle(40003, '08266.51782528'));
  await h.parts.ingestion.methods.update(h.viewer);
  assert.deepEqual([...h.state._catalog.keys()], [40000]);
  assert.equal(h.propagations, 1);
  const stats = h.parts.controls.methods.getStats();
  assert.equal(stats.count, 1);
  assert.ok(stats.withheldElements.expired > 0);
  assert.ok(stats.withheldElements.futureEpoch > 0);
  assert.equal(stats.stale, true);
});

test('open-session expiry stops core propagation, analyst/search results, labels and toggle revival', async () => {
  const h = harness();
  await h.parts.ingestion.methods.update(h.viewer);
  const point = h.state._points.get(40000), path = { primitive: { show: true } };
  h.state._orbitPaths.set(40000, path);
  h.state._catalog.set(25544, { ...h.state._catalog.get(40000) });
  h.state._points.set(25544, { ...point });
  assert.ok(h.parts.labels._issDisplayCached());
  h.setClock(EPOCH + MAX_ELEMENT_AGE_MS);
  const before = h.propagations;
  assert.equal(h.parts.rendering._propagateAll(), 0);
  assert.equal(h.propagations, before);
  assert.equal(point.show, false);
  assert.equal(path.primitive.show, false);
  assert.equal(h.parts.controls.methods.findByQuery('40000'), null);
  assert.deepEqual(h.parts.controls.methods.getAllPositions(), []);
  assert.deepEqual(h.parts.controls.methods.getDetectableObjects(), []);
  assert.deepEqual(h.parts.records.getAnalystRecords(), []);
  assert.equal(h.parts.labels._issDisplayCached(), null);
  assert.equal(h.parts.controls.methods.trackById(40000), false);
  h.parts.controls.methods.setParams({ showPoints: true, showOrbits: true });
  h.parts.lifecycle.methods.enable(h.viewer);
  assert.equal(point.show, false);
  assert.equal(path.primitive.show, false);
  assert.equal(h.parts.controls.methods.getStats().count, 0);
  assert.equal(h.propagations, before);
});

test('dense ingestion retains provenance and round-robin expiry performs no further SGP4 work', async () => {
  const h = harness();
  h.state._params.catalog = 'dense';
  h.setDenseBody(tle(40001) + tle(40002, '08254.51782528'));
  const loaded = await h.parts.catalog._loadDenseCatalog();
  assert.equal(loaded.status, 'ready');
  assert.equal(loaded.added, 1);
  assert.equal(h.state._catalog.get(40001).source.group, 'starlink');
  assert.equal(h.state._catalog.get(40001).source.retrievedAt, new Date(RETRIEVED).toISOString());
  assert.equal(h.parts.controls.methods.getStats().withheldElements.expired, 1);
  const point = h.state._points.get(40001), before = h.propagations;
  h.setClock(EPOCH + MAX_ELEMENT_AGE_MS);
  h.parts.catalog._propagateDenseChunk();
  assert.equal(point.show, false);
  assert.equal(h.propagations, before);
});

test('tracked predictions share actual render samples and expire before reuse of a cached frame', async () => {
  const h = harness();
  await h.parts.ingestion.methods.update(h.viewer);
  h.state._orbitPaths.set(40000, { primitive: { show: true } });
  h.parts.tracking._trackSatellite(40000);
  const entity = h.state._trackedEntity;
  const first = h.parts.tracking._getTrackedFramePosition();
  assert.ok(first);
  assert.ok(entity.gevLabelModel.details.includes('SGP4 prediction'));
  assert.ok(entity.gevLabelModel.details.some((line) => line.includes(new Date(EPOCH).toISOString())));
  assert.ok(entity.gevLabelModel.details.some((line) => line.includes(new Date(RETRIEVED).toISOString())));
  h.setClock(CLOCK + 1000);
  h.viewer.scene.frameState.frameNumber++;
  const second = h.parts.tracking._getTrackedFramePosition();
  assert.notEqual(second.longitude, first.longitude);
  assert.equal(h.parts.controls.methods.getTrackedInfo().calculatedAt, new Date(CLOCK + 1000).toISOString());
  const before = h.propagations;
  h.setClock(EPOCH + MAX_ELEMENT_AGE_MS);
  assert.equal(h.parts.tracking._getTrackedFramePosition(), null);
  assert.equal(h.parts.controls.methods.getTrackedInfo(), null);
  assert.equal(entity.position.getValue(Cesium.JulianDate.now()), undefined);
  assert.equal(entity.show, false);
  assert.equal(h.propagations, before);
  h.parts.rendering._preRenderTick();
  assert.equal(h.state._trackedNorad, null);
  assert.equal(h.state._points.get(40000).show, false);
});

test('mission orbit wrappers and pass predictions admit only the supported calculation interval', async () => {
  const h = harness();
  await h.parts.ingestion.methods.update(h.viewer);
  const track = h.parts.orbits.getSatelliteOrbitTrack('40000');
  assert.equal(track.provenance.sourceRetrievedAt, new Date(RETRIEVED).toISOString());
  assert.ok(track.positionAt(new Date(CLOCK + 1000)));
  assert.equal(track.positionAt(new Date(EPOCH + MAX_ELEMENT_AGE_MS)), null);
  assert.equal(track.positionAt(new Date(EPOCH - MAX_ELEMENT_FUTURE_MS - 1)), null);
  assert.equal(track.positionAt(new Date(NaN)), null);
  h.setClock(EPOCH + MAX_ELEMENT_AGE_MS);
  assert.equal(h.parts.orbits.getSatelliteOrbitTrack('40000'), null);
  assert.deepEqual(h.parts.orbits.getNextSatellitePass(40000, { latDeg: 30, lonDeg: -97, fromMs: EPOCH + MAX_ELEMENT_AGE_MS }), { status: 'no-tle' });
});
