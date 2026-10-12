import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthRuntime } from './index.js';
import { PREPARED_USGS_POLICY } from './prepared-usgs-scene.js';

test('the actual hosted router owns bounded prepared queries before providers and preserves document security', async () => {
  let sourceCalls = 0, edgeCalls = 0;
  const runtime = createEarthRuntime({
    fetchImpl: async () => { ++sourceCalls; throw new Error('Visitor delivery cannot acquire'); },
    cache: { async match() { ++edgeCalls; }, async put() { ++edgeCalls; } },
  });
  const request = (suffix = '', method = 'GET') => new Request(`https://example.com/earth/api/layers/earthquakes/scene${suffix}`, { method });
  try {
    const invalid = await runtime.fetch(request('?level=0'));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).errorCode, 'invalid-scene-query');
    const rejected = await runtime.fetch(request('?level=0&cells=', 'POST'));
    assert.equal(rejected.status, 405); assert.equal(rejected.headers.get('allow'), 'GET');
    const missing = await runtime.fetch(request('?level=0&cells='));
    assert.equal(missing.status, 503);
    const body = await missing.json();
    assert.equal(body.policyId, PREPARED_USGS_POLICY);
    assert.equal(body.available, false); assert.equal(body.configured, false);
    assert.equal(body.scene, null); assert.equal(body.delta, null);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');
    assert.match(missing.headers.get('content-security-policy'), /object-src 'none'/);
    assert.equal(sourceCalls, 0); assert.equal(edgeCalls, 0);
  } finally { runtime.close(); }
});

test('hosted coverage status is stored-only, rejects public mutations and never enters providers or edge acquisition cache', async () => {
  let reads = 0;
  const runtime = createEarthRuntime({ fetchImpl: async () => { reads++; throw Error('No provider'); },
    cache: { async match() { reads++; }, async put() { reads++; } } });
  try {
    const request = (query = '', method = 'GET') => new Request(`https://example.com/earth/api/coverage/status${query}`, { method });
    assert.equal((await runtime.fetch(request('', 'POST'))).status, 405);
    assert.equal((await runtime.fetch(request('?url=https://elsewhere.example'))).status, 400);
    const response = await runtime.fetch(request()); assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.configured, false); assert.equal(body.available, false);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(reads, 0);
  } finally { runtime.close(); }
});
