import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createEarthRuntime } from './index.js';
import { createCachedFetch, responseCachePolicy } from '../src/core/cached-fetch.js';
import { renderServiceWorker } from '../scripts/service-worker-runtime.mjs';

// Synthetic requests, cache and storage only. No HTTP calls or production writes.
const ORIGIN = 'https://giovannicallebaut.com', NOW = Date.parse('2026-10-11T12:00:00.000Z');
const KEY = 'discovery/demand/days/2026-10-11.json';
const ACTION = { subjectId: 'gkg:WB_698_TRADE', country: 'BE', consent: true };
function bucket() {
  const items = new Map(), writes = []; let version = 0;
  return { items, writes,
    async get(key) {
      const value = items.get(key);
      return value ? { etag: value.etag, size: new TextEncoder().encode(value.text).byteLength, text: async () => value.text } : null;
    },
    async put(key, text, options = {}) {
      const previous = items.get(key), condition = options.onlyIf;
      if (condition?.get?.('if-none-match') === '*' && previous || condition?.etagMatches && previous?.etag !== condition.etagMatches) return null;
      const etag = String(++version); writes.push({ key, text, options }); items.set(key, { etag, text }); return { etag };
    },
    async list({ prefix, limit }) {
      const keys = [...items.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit };
    },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key); },
  };
}
const request = (path = 'discovery/demand', { method = 'GET', origin = ORIGIN, headers = {}, payload = ACTION } = {}) =>
  new Request(`${origin}/earth/api/${path}`, { method, headers: {
    ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
  }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
function fixture() {
  const storage = bucket(), metrics = { match: 0, put: 0, feeds: 0 };
  const runtime = createEarthRuntime({ now: () => NOW, providers: [],
    fetchImpl: async () => { metrics.feeds++; throw new Error('A demand route must not load any feed'); },
    cache: {
      async match() { metrics.match++; return Response.json({ cachedPrivateDemand: true }, { headers: { 'cache-control': 'public, max-age=60' } }); },
      async put() { metrics.put++; },
    } });
  return { runtime, storage, metrics, env: { EARTH_STORE: storage } };
}

test('mounted demand owns its POST before generic guards and never enters edge caching', async () => {
  const { runtime, storage, metrics, env } = fixture();
  for (const incoming of [request(), request(undefined, { method: 'POST' }), request('discovery/demand/summary')]) {
    const response = await runtime.fetch(incoming, env);
    assert.ok([200, 202].includes(response.status)); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.notEqual((await response.json()).cachedPrivateDemand, true);
  }
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(JSON.parse(storage.items.get(KEY).text), { version: 1, day: '2026-10-11', counts: { 'gkg:WB_698_TRADE|BE': 1 } });
  assert.deepEqual(metrics, { match: 0, put: 0, feeds: 0 });
  const other = await runtime.fetch(request('intelligence', { method: 'POST' }), env);
  assert.equal(other.status, 405, 'the extension does not loosen another provider method'); runtime.close();
});

test('mounted demand preserves production-only and test exclusion checks through prefix rewriting', async () => {
  const { runtime, storage, env, metrics } = fixture();
  const excluded = [
    request(undefined, { method: 'POST', origin: 'http://localhost:4174' }),
    request(undefined, { method: 'POST', headers: { 'x-earth-test': 'synthetic-journey' } }),
    request(undefined, { method: 'POST', headers: { origin: 'https://other.example' } }),
    request(undefined, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }),
    request('discovery/demand/summary', { headers: { 'x-earth-test': '' } }),
  ];
  for (const incoming of excluded) {
    const response = await runtime.fetch(incoming, env);
    assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const payload of [{ ...ACTION, q: 'private free text' }, { ...ACTION, lat: 50.8 }, { ...ACTION, consent: false }]) {
    assert.equal((await runtime.fetch(request(undefined, { method: 'POST', payload }), env)).status, 400);
  }
  assert.equal(storage.writes.length, 0); assert.deepEqual(metrics, { match: 0, put: 0, feeds: 0 }); runtime.close();
});

test('mounted demand rejects unsupported methods with its exact Allow contract', async () => {
  const { runtime, env, metrics } = fixture();
  for (const [path, method, allow] of [
    ['discovery/demand', 'HEAD', 'GET, POST'], ['discovery/demand', 'PUT', 'GET, POST'],
    ['discovery/demand/summary', 'POST', 'GET'], ['discovery/demand/summary', 'DELETE', 'GET'],
  ]) {
    const response = await runtime.fetch(request(path, { method }), env);
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allow);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(metrics, { match: 0, put: 0, feeds: 0 }); runtime.close();
});

test('mounted summaries see a newly accepted threshold action and expose only aggregate buckets', async () => {
  const { runtime, env, storage } = fixture();
  await storage.put(KEY, JSON.stringify({ version: 1, day: '2026-10-11', counts: { 'gkg:WB_698_TRADE|BE': 299 } }));
  const before = await (await runtime.fetch(request('discovery/demand/summary'), env)).json(); assert.deepEqual(before.groups, []);
  assert.equal((await runtime.fetch(request(undefined, { method: 'POST' }), env)).status, 202);
  const after = await (await runtime.fetch(request('discovery/demand/summary'), env)).json();
  assert.deepEqual(after.groups, [{ subjectId: 'gkg:WB_698_TRADE', label: 'Trade', country: 'BE', actions: 300 }]);
  assert.match(after.unit, /not unique people/); assert.equal(after.records, undefined); runtime.close();
});

test('browser caching delegates all demand methods directly without storage or request coalescing', async () => {
  let calls = 0, storageCalls = 0;
  const touch = () => { storageCalls++; throw new Error('Demand metadata must not enter browser storage'); };
  const fetchImpl = createCachedFetch({ origin: ORIGIN, store: { get: touch, put: touch, all: touch, delete: touch },
    fetchImpl: async () => { calls++; return Response.json({ enabled: true }, { headers: { 'cache-control': 'no-store' } }); } });
  for (const path of ['/api/discovery/demand', '/api/discovery/demand/summary']) {
    assert.equal(responseCachePolicy(new URL(path, ORIGIN)), null);
    await Promise.all([fetchImpl(path), fetchImpl(path)]);
  }
  await fetchImpl('/api/discovery/demand', { method: 'POST', body: JSON.stringify(ACTION), cache: 'no-store', credentials: 'omit' });
  assert.equal(calls, 5); assert.equal(storageCalls, 0); fetchImpl.destroy();
});

test('generated service worker never intercepts root or mounted demand endpoints', () => {
  const listeners = new Map();
  vm.runInNewContext(renderServiceWorker({ critical: ['/earth/'], version: 'fixture', scope: '/earth/' }), {
    self: { addEventListener: (name, callback) => listeners.set(name, callback) }, URL, Response,
    location: { origin: ORIGIN }, caches: { match() { assert.fail('Demand must bypass CacheStorage'); } },
    fetch() { assert.fail('Demand must bypass service-worker transport'); },
  });
  for (const path of ['/api/discovery/demand', '/api/discovery/demand/summary', '/earth/api/discovery/demand', '/earth/api/discovery/demand/summary']) {
    for (const method of ['GET', 'POST']) listeners.get('fetch')({ request: {
      method, mode: 'navigate', url: ORIGIN + path, headers: new Headers(),
    }, respondWith() { assert.fail('Demand route must not be intercepted'); } });
  }
});
