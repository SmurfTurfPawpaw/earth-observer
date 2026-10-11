import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PbfWriter } from 'pbf';
import { createOpenFreeMapImageryProvider, decodeBasemapTile, nativeBasemapTile, paintBasemapTile, validateOpenFreeMapMetadata, OPEN_FREE_MAP_CREDIT } from './openFreeMapImagery.js';

const metadata = { tiles: ['https://tiles.openfreemap.org/planet/example/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 };
const actualRoadTile = new Uint8Array(readFileSync(new URL('../data/fixtures/ofm-austin-14-3743-6745.pbf', import.meta.url)));
function canvasFactory() {
  const operations = [];
  const context = new Proxy({ measureText: (text) => ({ width: text.length * 6 }) }, { get(target, key) {
    if (key in target) return target[key]; return (...args) => operations.push([key, ...args]);
  } });
  return { width: 0, height: 0, operations, getContext: () => context };
}
function scheduler() {
  const active = new Set();
  return { request(request) { active.add(request); return request.requestFunction().finally(() => active.delete(request)); },
    update() { for (const request of active) if (request.cancelled) request.cancelFunction(); } };
}
function fixture() {
  const writer = new PbfWriter();
  function layer(value, pbf) {
    pbf.writeVarintField(15, 2); pbf.writeStringField(1, value.name); pbf.writeVarintField(5, 4096);
    for (const key of ['class', 'name:en']) pbf.writeStringField(3, key);
    for (const text of value.values) pbf.writeMessage(4, (text, p) => p.writeStringField(1, text), text);
    pbf.writeMessage(2, (_, p) => { p.writePackedVarint(2, [0, 0, 1, 1]); p.writeVarintField(3, value.type); p.writePackedVarint(4, value.geometry); }, null);
  }
  writer.writeMessage(3, layer, { name: 'place', values: ['city', 'Example City'], type: 1, geometry: [9, 4096, 2048] });
  writer.writeMessage(3, layer, { name: 'transportation', values: ['primary', 'Main Road'], type: 2, geometry: [9, 0, 4096, 10, 8192, 0] });
  writer.writeMessage(3, layer, { name: 'transportation_name', values: ['primary', 'Main Road'], type: 2, geometry: [9, 0, 4096, 10, 8192, 0] });
  writer.writeMessage(3, layer, { name: 'water', values: ['lake', 'Example Lake'], type: 3, geometry: [9, 2048, 2048, 26, 4096, 0, 0, 4096, 4095, 0, 15] });
  return writer.finish();
}

test('basemap metadata admits only the cleared versioned OpenFreeMap source and preserves mandatory linked credit', () => {
  assert.equal(validateOpenFreeMapMetadata(metadata).maxzoom, 14);
  for (const url of ['https://elsewhere.example/planet/{z}/{x}/{y}.pbf', 'http://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf', 'https://tiles.openfreemap.org/other/{z}/{x}/{y}.pbf', 'https://user@tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'])
    assert.throws(() => validateOpenFreeMapMetadata({ ...metadata, tiles: [url] }));
  assert.throws(() => validateOpenFreeMapMetadata({ ...metadata, maxzoom: 20 }));
  assert.match(OPEN_FREE_MAP_CREDIT, /https:\/\/www\.openmaptiles\.org\//);
  assert.match(OPEN_FREE_MAP_CREDIT, /https:\/\/www\.openstreetmap\.org\/copyright/);
});

test('overzoom maps child imagery to native level14 without requesting finer source data', () => {
  assert.deepEqual(nativeBasemapTile(3743 * 16 + 5, 6745 * 16 + 9, 18), { z: 14, x: 3743, y: 6745, scale: 16, offsetX: 5, offsetY: 9 });
  assert.throws(() => nativeBasemapTile(0, 0, 19)); assert.throws(() => nativeBasemapTile(4, 0, 2));
});

test('real vector geometry and synthetic place/road labels paint an opaque small canvas', () => {
  const actual = decodeBasemapTile(actualRoadTile);
  assert.ok(actual.layers.transportation.features.length > 0); assert.ok(actual.pointCount > 0);
  const decoded = decodeBasemapTile(fixture());
  assert.equal(decoded.layers.place.features[0].properties.name, 'Example City');
  const canvas = paintBasemapTile(decoded, { ...nativeBasemapTile(0, 0, 14), level: 14 }, { canvasFactory });
  assert.equal(canvas.width, 256); assert.equal(canvas.height, 256);
  assert.ok(canvas.operations.some(([operation]) => operation === 'fillRect'));
  assert.ok(canvas.operations.some(([operation, text]) => operation === 'fillText' && text === 'Example City'));
  assert.ok(canvas.operations.some(([operation, text]) => operation === 'fillText' && text === 'Main Road'));
  assert.ok(canvas.operations.some(([operation, rule]) => operation === 'fill' && rule === 'evenodd'));
  assert.throws(() => decodeBasemapTile(new Uint8Array(4 * 1024 * 1024 + 1)));
  assert.throws(() => decodeBasemapTile(new Uint8Array([255, 255, 255])));
});

test('native source fetch is shared by overzoom children and retained raster/native caches stay bounded', async () => {
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = await createOpenFreeMapImageryProvider({ metadata, scheduler: scheduler(), canvasFactory, maxRasterEntries: 2, maxNativeBytes: 100000,
    fetchImpl: async (url, options) => { calls++; assert.match(url, /\/14\/3743\/6745\.pbf$/); assert.equal(options.redirect, 'error'); await gate; return new Response(actualRoadTile); } });
  assert.equal(calls, 0);
  const first = provider.requestImage(3743 * 2, 6745 * 2, 15), second = provider.requestImage(3743 * 2 + 1, 6745 * 2, 15);
  release(); const [a, b] = await Promise.all([first, second]); assert.equal(calls, 1); assert.notEqual(a, b);
  assert.equal(await provider.requestImage(3743 * 2, 6745 * 2, 15), a); assert.equal(calls, 1);
  await provider.requestImage(3743 * 4, 6745 * 4, 16); assert.equal(calls, 1);
  assert.equal(provider.getStats().rasterEntries, 2); assert.equal(provider.getStats().rasterBytes, 2 * 256 * 256 * 4);
  assert.ok(provider.getStats().nativeBytes <= 100000);
  provider.destroy(); assert.equal(provider.getStats().nativeBytes, 0); assert.equal(provider.getStats().rasterEntries, 0);
});

test('Cesium backpressure declines excess work, and hiding cancels active transport before reopening', async () => {
  let calls = 0, observedSignal;
  const provider = await createOpenFreeMapImageryProvider({ metadata, scheduler: scheduler(), canvasFactory, maxConcurrent: 1,
    fetchImpl: async (url, options) => { calls++; observedSignal = options.signal; if (calls > 1) return new Response(fixture());
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  const pending = provider.requestImage(0, 0, 1); assert.equal(provider.requestImage(1, 0, 1), undefined);
  provider.setEnabled(false); await assert.rejects(pending); assert.equal(observedSignal.aborted, true); assert.equal(provider.getStats().activeRequests, 0);
  assert.equal(provider.requestImage(0, 0, 1), undefined);
  provider.setEnabled(true); assert.ok(await provider.requestImage(0, 0, 1)); assert.equal(calls, 2);
  provider.destroy(); assert.equal(provider.requestImage(0, 0, 1), undefined);
});

test('tile body caps and failed reads do not populate imagery caches', async () => {
  const provider = await createOpenFreeMapImageryProvider({ metadata, scheduler: scheduler(), canvasFactory,
    fetchImpl: async () => new Response('excess', { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } }) });
  await assert.rejects(provider.requestImage(0, 0, 0)); assert.equal(provider.getStats().rasterEntries, 0); assert.equal(provider.getStats().nativeEntries, 0); provider.destroy();
  let calls = 0;
  const declined = await createOpenFreeMapImageryProvider({ metadata, scheduler: { request: () => undefined }, canvasFactory, fetchImpl: async () => { calls++; return new Response(fixture()); } });
  assert.equal(declined.requestImage(0, 0, 0), undefined); assert.equal(calls, 0); declined.destroy();
});
