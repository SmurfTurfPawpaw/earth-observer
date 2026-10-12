import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherLayer } from './index.js';
import { createWindLayer } from '../wind/index.js';
import { createLayerManager } from '../../core/layer-manager.js';

const TIMES = ['2026-09-14T12:00:00.000Z', '2026-09-14T12:05:00.000Z'];
const observation = product => ({ product, times: TIMES, latest: TIMES.at(-1), bounds: { west: -180, south: -60, east: 180, north: 60 } });
const forecast = model => ({ model, grid: { nx: 2, ny: 2 }, u: new Float32Array(4), v: new Float32Array(4),
  cycle: { runIso: TIMES[0], validIso: TIMES[1] } });
const viewerFixture = () => ({ container: {}, imageryLayers: {}, scene: { requestRender() {} },
  camera: { moveEnd: { addEventListener: () => () => {} } } });
const documentFixture = () => ({ hidden: false, addEventListener() {}, removeEventListener() {} });
function weatherFixture(feed, viewer = viewerFixture(), documentRef = documentFixture()) {
  const frames = [], alphas = []; let shown = null;
  const rendering = { setAlpha(value) { alphas.push(value); }, rehome() {}, cancelPrefetch() {},
    clear() { shown = null; }, setHidden() {}, getDiagnostics: () => ({ time: shown, loading: false }),
    async setFrame(snapshot, time, options) { shown = time; frames.push({ product: snapshot.product, time, infrared: options.infrared }); return true; } };
  const layer = createWeatherLayer({ id: 'weather-satellite', feed, documentRef,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, matchMedia: () => null, createRendering: () => rendering });
  return { layer, frames, alphas, viewer };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Fixture operation settled within its bound'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('weather product acquisition belongs to its attached owner; opacity and dated-frame selection remain local', async () => {
  const reads = [], delegated = [];
  const fixture = weatherFixture({ getSnapshot: async args => { reads.push(args); return observation(args.product); } });
  const { layer, frames, alphas, viewer } = fixture;
  layer.init(viewer); layer.enable(); await layer.update();
  layer.attachDataManager({ requestRefresh(id) { delegated.push(id); return false; } });
  layer.setParams({ opacity: 'light', infrared: 'full' }); await settle();
  layer.setParams({ step: -1 }); await settle();
  layer.setParams({ latest: true }); await settle();
  assert.equal(reads.length, 1); assert.equal(delegated.length, 0);
  assert.equal(alphas.at(-1), .4);
  assert.deepEqual(frames.slice(-2).map(frame => frame.time), TIMES, 'Existing dated observations remain selectable without another manifest');
  layer.setParams({ product: 'clouds' }); await settle();
  assert.deepEqual(delegated, ['weather-satellite']); assert.equal(reads.length, 1);
  await layer.update();
  assert.equal(reads.length, 2); assert.equal(reads.at(-1).product, 'clouds');
  assert.equal(delegated.length, 1, 'Owned update never recursively asks for another refresh');
  assert.equal(layer.getStats().observedAt, TIMES.at(-1));
  layer.destroy();
});

test('standalone weather product refresh remains cancellable and cannot publish after disable', async () => {
  const pending = Promise.withResolvers(); let secondSignal, reads = 0;
  const fixture = weatherFixture({ getSnapshot(args) {
    if (++reads === 1) return Promise.resolve(observation(args.product));
    secondSignal = args.signal; return pending.promise;
  } });
  const { layer, viewer, frames } = fixture; layer.init(viewer); layer.enable(); await layer.update();
  layer.setParams({ product: 'clouds' });
  assert.equal(reads, 2); layer.disable(); assert.equal(secondSignal.aborted, true);
  pending.resolve(observation('clouds')); await settle();
  assert.equal(frames.length, 1); assert.equal(layer.getStats().observedAt, null);
  layer.destroy();
});

test('wind and weather source parameter changes share actual manager slots and coalesce before admission', async t => {
  const viewer = viewerFixture(), documentRef = documentFixture(), windGate = Promise.withResolvers(), blockerGate = Promise.withResolvers();
  const reads = { wind: [], weather: [] }, fields = [];
  let active = 0, maximum = 0, blockerReads = 0;
  const acquire = async (key, args, make, gate) => {
    reads[key].push(args); active++; maximum = Math.max(maximum, active);
    try { if (reads[key].length === 2 && gate) await gate.promise; return make(args); } finally { active--; }
  };
  const wind = createWindLayer({ feed: { getSnapshot: args => acquire('wind', args, args => forecast(args.model), windGate) },
    createRendering: () => ({ attach() {}, start() {}, stop() {}, clear() {}, destroy() {}, setOptions() {},
      getDiagnostics: () => ({}), setField(value) { fields.push(value.model); } }) });
  const weather = weatherFixture({ getSnapshot: args => acquire('weather', args, args => observation(args.product)) }, viewer, documentRef).layer;
  const blocker = { updateInterval: 0, init() {}, enable() {}, disable() {}, destroy() {}, getStats: () => ({ count: 1, lastUpdate: 1 }),
    async update() { if (++blockerReads !== 2) return true; active++; maximum = Math.max(maximum, active);
      try { await blockerGate.promise; return true; } finally { active--; } } };
  const layers = { wind, 'weather-satellite': weather, blocker };
  const manager = createLayerManager(viewer, () => {}, { document: documentRef, storage: null,
    catalog: Object.keys(layers).map(id => ({ id, defaults: {} })), createLayer: async id => layers[id],
    layerServiceRequirements: () => [], setInterval: () => 0, clearInterval() {} });
  t.after(async () => { windGate.resolve(); blockerGate.resolve(); await manager.destroy(); });
  await manager.restore(Object.keys(layers));
  const busyWind = manager.refresh('wind'), busyBlocker = manager.refresh('blocker');
  await until(() => reads.wind.length === 2 && blockerReads === 2);
  assert.equal(manager.getWorkState().activeUpdates, 2);
  manager.setLayerParams('weather-satellite', { product: 'clouds' });
  manager.setLayerParams('weather-satellite', { product: 'clouds-regional' });
  manager.setLayerParams('wind', { model: 'ifs' });
  manager.setLayerParams('wind', { model: 'gfs' });
  manager.setLayerParams('wind', { model: 'ifs' });
  await settle();
  assert.equal(reads.weather.length, 1); assert.equal(reads.wind.length, 2, 'No direct read bypasses occupied physical slots');
  assert.equal(reads.wind[1].signal.aborted, true);
  blockerGate.resolve(); await busyBlocker;
  await until(() => reads.weather.length === 2 && manager.getWorkState().activeUpdates === 1);
  assert.equal(reads.weather.at(-1).product, 'clouds-regional', 'Queued source intent reads the latest selected product once');
  windGate.resolve(); await busyWind;
  await until(() => reads.wind.length === 3 && manager.getWorkState().activeUpdates === 0 && manager.getState().wind.workPhase === 'complete');
  assert.equal(reads.wind.at(-1).model, 'ifs'); assert.deepEqual(fields, ['gfs', 'ifs'], 'An abort-insensitive older field does not publish after model selection');
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(reads.weather.length, 2); assert.equal(reads.wind.length, 3, 'Exactly one latest-owner follow-up; no recursive update loop');
  assert.ok(maximum <= 2); assert.equal(active, 0);
  assert.equal(weather.getStats().observedAt, TIMES.at(-1));
  assert.equal(wind.getStats().lastUpdate, Date.parse(TIMES[0]), 'Display preparation preserves the source issue time');
});
