import test from 'node:test';
import assert from 'node:assert/strict';
import { layerServiceRequirements, preloadLayer } from './layer-factories.js';

test('real selective module imports make no dataset or API requests and share engine groups', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Warm-up cannot fetch data'); };
  try {
    assert.equal(preloadLayer('flights'), preloadLayer('military'));
    await Promise.all([preloadLayer('flights'), preloadLayer('weather-radar'), preloadLayer('local-firms'), preloadLayer('local-datacenters')]);
    assert.equal(requests, 0);
    assert.deepEqual(layerServiceRequirements('weather-radar'), ['weatherClock']);
    assert.deepEqual(layerServiceRequirements('recent-imagery'), ['render']);
    assert.deepEqual(layerServiceRequirements('local-firms'), []);
    assert.deepEqual(layerServiceRequirements('local-datacenters'), []);
    assert.deepEqual(layerServiceRequirements('local-dams'), []);
  } finally { globalThis.fetch = originalFetch; }
});
