import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { firmsProxy } from '../../server/providers/firms.js';
import { createFireDetectionsLayer } from './firms.js';

test('keyless FIRMS returns real, dated archive metadata without touching upstream', async () => {
  const savedKey = process.env.FIRMS_MAP_KEY;
  const savedFetch = globalThis.fetch;
  delete process.env.FIRMS_MAP_KEY;
  globalThis.fetch = () => { throw new Error('Keyless requests must not fetch upstream'); };
  try {
    let handler;
    const plugin = firmsProxy();
    plugin.configureServer({ middlewares: { use(path, callback) { assert.equal(path, '/api/firms'); handler = callback; } } });
    async function request(url) {
      let status, payload;
      await handler({ url }, {
        headersSent: false,
        writeHead(code) { status = code; },
        end(body) { payload = JSON.parse(body); },
      });
      return { status, payload };
    }
    const { status, payload } = await request('/');
    assert.equal(status, 200);
    assert.equal(payload.snapshot, true);
    assert.equal(payload.stale, true);
    assert.equal(payload.mode, 'archived-sample');
    assert.equal(payload.observationDate, '2026-07-16');
    assert.equal(payload.count, payload.fires.length);
    assert.ok(payload.count > 0);
    assert.match(payload.coverage, /not current|not.*comprehensive/);
    const health = await request('/status');
    assert.equal(health.payload.hasKey, false);
    assert.equal(health.payload.snapshot, true);
    assert.equal(health.payload.observationDate, payload.observationDate);
  } finally {
    if (savedKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
});

test('the dated FIRMS archive renders every real detection without an error or camera motion', async () => {
  const archive = JSON.parse(await readFile(new URL('../data/local_data/firms/snapshot.json', import.meta.url), 'utf8'));
  const sources = new Set();
  let cameraMoves = 0, payload = archive;
  const viewer = { dataSources: { add: (source) => sources.add(source), remove: (source) => sources.delete(source) },
    scene: { requestRender() {} }, camera: { flyTo() { cameraMoves++; } }, isDestroyed: () => false };
  const layer = createFireDetectionsLayer({ source: { getSnapshot: async () => payload } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.count, 45);
  assert.equal(stats.snapshot, true);
  assert.equal(stats.observationDate, '2026-07-16');
  assert.equal(stats.error, null);
  assert.match(stats.coverage, /not current/);
  assert.equal([...sources][0].entities.values.length, 45);
  assert.equal([...sources][0].entities.values[0].position.isConstant, true);
  assert.equal([...sources][0].entities.values[0].properties.dataMode.getValue(), 'Archived sample; not current conditions');
  assert.equal(cameraMoves, 0);
  layer.setParams({ focusDetections: true });
  assert.equal(cameraMoves, 1);
  payload = { snapshot: false, mode: 'live', stale: false, fires: [archive.fires[0]], fetchedAt: Date.now() };
  await layer.update(viewer);
  assert.equal(layer.getStats().snapshot, false);
  assert.equal(layer.getStats().observationDate, null);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy(); assert.equal(sources.size, 0);
});
