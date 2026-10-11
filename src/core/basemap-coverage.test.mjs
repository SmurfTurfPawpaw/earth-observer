import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Event, ImageryLayer, ImageryState, TileImagery, Cartesian4 } from 'cesium';
import { observeStreetMapCoverage, streetMapCoverageNotice } from './basemap-coverage.js';
import { createOpenFreeMapImageryProvider } from '../maps/openFreeMapImagery.js';

const origin = 'https://tiles.openfreemap.org';
const template = `${origin}/planet/20261004_113936_pt/{z}/{x}/{y}.pbf`;
const metadata = { tiles: [template], minzoom: 0, maxzoom: 14 };
const fixture = new Uint8Array(readFileSync(new URL('../data/fixtures/ofm-austin-14-3743-6745.pbf', import.meta.url)));
const tileUrl = (x, y, z) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
function canvasFactory() {
  const context = new Proxy({ measureText: (text) => ({ width: text.length * 6 }) }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
  });
  return { width: 0, height: 0, getContext: () => context };
}
const scheduler = { request: (request) => request.requestFunction() };

test('a run of ancestor errors describes partial coverage without destroying or disabling real street detail', () => {
  let destroyed = 0, disabled = 0;
  const provider = { errorEvent: new Event(), getStats: () => ({}), destroy: () => destroyed++, setEnabled: () => disabled++ };
  const changes = [], coverage = observeStreetMapCoverage(provider, (state) => changes.push(state));
  for (let i = 0; i < 20; i++) provider.errorEvent.raiseEvent(new Error('An uncached ancestor is offline'));
  assert.equal(coverage.getState().status, 'partial');
  assert.equal(coverage.getState().failedRequests, 20);
  assert.equal(changes.length, 1, 'coverage notices are not repeated for every missing tile');
  assert.equal(destroyed, 0); assert.equal(disabled, 0);
  assert.match(streetMapCoverageNotice(coverage.getState()), /gaps use bundled imagery/i);
  coverage.destroy(); coverage.destroy();
  assert.equal(provider.errorEvent.numberOfListeners, 0);
  provider.errorEvent.raiseEvent(new Error('Disposed observer'));
  assert.equal(coverage.getState().failedRequests, 20);
});

test('restored metadata alone never claims that street tiles came from saved coverage', () => {
  const stats = { savedMetadataAt: 1000, savedTileReads: 0, latestCachedAt: null };
  const provider = { errorEvent: new Event(), getStats: () => stats };
  const changes = [], coverage = observeStreetMapCoverage(provider, (state) => changes.push(state));
  coverage.tileSucceeded();
  assert.equal(changes.length, 0); assert.equal(streetMapCoverageNotice(coverage.getState()), '');
  stats.savedTileReads = 1; stats.latestCachedAt = 2000; coverage.tileSucceeded();
  assert.equal(changes.length, 1); assert.match(streetMapCoverageNotice(changes[0]), /^Saved street-map tiles/);
  provider.errorEvent.raiseEvent(new Error('Unknown area'));
  assert.match(streetMapCoverageNotice(changes[1]), /^Saved street-map detail/);
  assert.equal(changes[1].latestCachedAt, 2000);
  coverage.tileSucceeded();
  assert.equal(changes.length, 2, 'one saved tile does not imply all missing coverage recovered');
  assert.equal(coverage.getState().status, 'partial');
  coverage.destroy();
});

test('a cached vector child remains available after eight actual Cesium ancestor failures, with no additional downloads', { timeout: 5000 }, async (t) => {
  const requested = [], notices = [], savedAt = Date.now() - 600000;
  let coverage, finishTile;
  const provider = await createOpenFreeMapImageryProvider({ canvasFactory, scheduler,
    onTile: () => { coverage?.tileSucceeded(); finishTile?.(); },
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === `${origin}/planet`) return new Response(JSON.stringify(metadata), { headers: { 'x-earth-map-cached-at': String(savedAt) } });
      if (url === tileUrl(3743, 6745, 14)) return new Response(fixture, { headers: { 'x-earth-map-cached-at': String(savedAt) } });
      throw new Error('Offline: this tile was not visited');
    },
  });
  coverage = observeStreetMapCoverage(provider, (state) => notices.push(state));
  const layer = new ImageryLayer(provider);
  t.after(() => { coverage.destroy(); layer.destroy(); provider.destroy(); });
  const ancestors = [[0, 0, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1], [0, 0, 2], [1, 0, 2], [0, 1, 2]];
  for (const [x, y, level] of ancestors) {
    const imagery = layer.getImageryFromCache(x, y, level);
    await new Promise((resolve) => {
      const remove = provider.errorEvent.addEventListener(() => { remove(); resolve(); });
      layer._requestImagery(imagery);
    });
    assert.equal(imagery.state, ImageryState.FAILED);
  }
  assert.equal(coverage.getState().failedRequests, 8);
  assert.equal(provider.isDestroyed(), false);
  assert.equal(layer.isDestroyed(), false);
  const child = layer.getImageryFromCache(3743, 6745, 14);
  const completed = new Promise((resolve) => { finishTile = resolve; });
  layer._requestImagery(child);
  await completed; await new Promise(setImmediate);
  assert.equal(child.state, ImageryState.RECEIVED);
  assert.equal(child.image.width, 256);
  assert.equal(coverage.getState().savedTileReads, 1);
  assert.equal(coverage.getState().latestCachedAt, savedAt);
  assert.equal(coverage.getState().status, 'partial');
  assert.match(streetMapCoverageNotice(notices.at(-1)), /Saved street-map detail/);
  // Model completion of the GPU texture stage; no browser/WebGL rendering is
  // claimed. Exercise Cesium's actual hierarchy acceptance after failed roots.
  child.state = ImageryState.READY; child.texture = {};
  const tileImagery = new TileImagery(child, new Cartesian4(0, 0, 1, 1), true);
  assert.equal(tileImagery.processStateMachine({ rectangle: child.rectangle }, {}, false), true);
  assert.equal(tileImagery.readyImagery, child);
  assert.equal(provider.isDestroyed(), false);
  await provider.requestImage(3743 * 2, 6745 * 2, 15);
  await provider.requestImage(3743 * 2 + 1, 6745 * 2, 15);
  assert.equal(requested.length, 10, 'metadata + eight misses + one real saved native tile; overzoom reuses it');
  assert.ok(requested.every((url) => url === `${origin}/planet` || /\/(?:0|1|2|14)\//.test(url)));
  const stats = provider.getStats();
  assert.ok(stats.nativeBytes <= 16 * 1024 * 1024);
  assert.ok(stats.rasterEntries <= 64); assert.ok(stats.rasterBytes <= 64 * 256 * 256 * 4);
  assert.equal(stats.activeRequests, 0);
  assert.equal(provider.maximumLevel, 18);
  await assert.rejects(provider.requestImage(3744, 6745, 14), /not visited/);
  assert.equal(provider.isDestroyed(), false);
});

test('unavailable metadata still rejects provider initialization rather than inventing a street layer', async () => {
  let requests = 0;
  await assert.rejects(createOpenFreeMapImageryProvider({ fetchImpl: async () => { requests++; return new Response('Offline', { status: 503 }); } }), /metadata HTTP 503/);
  assert.equal(requests, 1);
});
