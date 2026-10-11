import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderServiceWorker } from '../scripts/service-worker-runtime.mjs';

const origin = 'https://example.com', engine = '/earth/cesium/1.138.0/Cesium.js';
function response(body, route = engine, headers = {}) {
  const result = new Response(body, { headers }); Object.defineProperty(result, 'url', { value: origin + route }); return result;
}
function harness({ fetchImpl, online = true, values = new Map(), putImpl, openImpl } = {}) {
  const listeners = new Map(), reads = [], writes = [], fetches = [], timers = new Map(), messages = [];
  let timerId = 0;
  const cache = (name) => ({
    async match(request) { const route = typeof request === 'string' ? request : new URL(request.url).pathname; reads.push([name, route]); return values.get(name + ':' + route)?.clone(); },
    async put(request, body) { writes.push([name, request]); if (putImpl) return putImpl(request, body); },
    async keys() { return []; },
    async delete() { return true; },
  });
  const context = {
    self: { navigator: { onLine: online }, addEventListener: (name, fn) => listeners.set(name, fn), clients: { async get() { return { postMessage(message) { messages.push(message); } }; } } },
    location: { origin }, URL, Response, AbortController,
    caches: { async open(name) { if (openImpl) await openImpl(name); return cache(name); } },
    fetch(request, options) { fetches.push([request, options]); return fetchImpl(request, options); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(renderServiceWorker({ version: 'fixture', critical: ['/earth/', engine, '/earth/assets/main-one.js'], scope: '/earth/' }), context);
  function dispatch(route, { mode = 'cors', clientId = 'page' } = {}) {
    const pending = []; let result;
    listeners.get('fetch')({ request: { method: 'GET', mode, url: origin + route, headers: new Headers() }, clientId, resultingClientId: mode === 'navigate' ? clientId : '', respondWith(value) { result = value; }, waitUntil(value) { pending.push(value); } });
    return { get result() { return result; }, pending };
  }
  return { dispatch, reads, writes, fetches, timers, messages, listeners };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Response waited for background storage')), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('online essential Cesium uses browser HTTP caching without any CacheStorage read or duplicate write', async () => {
  const h = harness({ fetchImpl: async () => response('online engine') });
  const event = h.dispatch(engine), result = await event.result;
  assert.equal(await result.text(), 'online engine'); assert.equal(h.fetches[0][1].cache, 'default');
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.timers.size, 0);
});

test('online HTML is returned while a cache write is still unresolved; public cache writes run in waitUntil', async () => {
  const h = harness({ fetchImpl: async () => response('online page', '/earth/', { 'content-type': 'text/html' }), putImpl: () => new Promise(() => {}) });
  const event = h.dispatch('/earth/', { mode: 'navigate' });
  assert.equal(await (await bounded(event.result)).text(), 'online page');
  assert.equal(h.writes.length, 1); assert.equal(event.pending.length, 1); assert.equal(h.reads.length, 0);
});

test('the response is cloned before background storage yields, so HTML can be consumed while the cache opens', async () => {
  let release, stored;
  const opening = new Promise((resolve) => { release = resolve; });
  const h = harness({ fetchImpl: async () => response('streamed page', '/earth/', { 'content-type': 'text/html' }), openImpl: () => opening, putImpl: async (_, copy) => { stored = await copy.text(); } });
  const event = h.dispatch('/earth/', { mode: 'navigate' });
  assert.equal(await (await bounded(event.result)).text(), 'streamed page');
  release(); await Promise.all(event.pending); assert.equal(stored, 'streamed page');
});

test('offline engine comes from the current shell cache without attempting a network request and is honestly reported', async () => {
  const values = new Map([['earth-observer-shell-fixture:' + engine, response('offline engine')]]);
  const h = harness({ online: false, values, fetchImpl() { assert.fail('Offline fetch'); } });
  const event = h.dispatch(engine), result = await event.result; await Promise.all(event.pending);
  assert.equal(await result.text(), 'offline engine'); assert.equal(h.fetches.length, 0); assert.equal(h.reads[0][0], 'earth-observer-shell-fixture');
  assert.match(h.messages[0].message, /offline storage/);
  const handshake = [];
  h.listeners.get('message')({ data: { type: 'earth-observer:shell-status' }, source: { id: 'page', postMessage(message) { handshake.push(message); } } });
  assert.equal(handshake[0].message, h.messages[0].message);
});

test('an unresponsive online navigation aborts at the bounded timeout and falls back to its saved document', async () => {
  const values = new Map([['earth-observer-shell-fixture:/earth/', response('saved page', '/earth/')]]);
  const h = harness({ values, fetchImpl: () => new Promise(() => {}) });
  const event = h.dispatch('/earth/', { mode: 'navigate' });
  assert.equal(h.timers.size, 1); [...h.timers.values()][0]();
  assert.equal(await (await event.result).text(), 'saved page'); await Promise.all(event.pending);
  assert.equal(h.fetches[0][1].signal.aborted, true); assert.match(h.messages[0].message, /server was unavailable/);
});

test('network failures fall back to runtime optional assets while a fresh first visit has an honest unavailable response', async () => {
  const route = '/earth/assets/optional-one.js';
  const values = new Map([['earth-observer-assets-v2:' + route, response('saved optional', route)]]);
  const h = harness({ values, fetchImpl: async () => { throw new Error('Network unavailable'); } });
  assert.equal(await (await h.dispatch(route).result).text(), 'saved optional');
  const first = harness({ online: false, fetchImpl() { assert.fail('Offline fetch'); } });
  const missing = await first.dispatch('/earth/', { mode: 'navigate' }).result;
  assert.equal(missing.status, 503); assert.match(await missing.text(), /Reconnect for the first visit/);
});

test('private/no-store documents and redirected responses are never persisted', async () => {
  for (const headers of [{ 'cache-control': 'private' }, { 'cache-control': 'no-store' }, { 'set-cookie': 'session=secret' }]) {
    const h = harness({ fetchImpl: async () => response('page', '/earth/', { 'content-type': 'text/html', ...headers }) });
    const event = h.dispatch('/earth/', { mode: 'navigate' }); await event.result; await Promise.all(event.pending); assert.equal(h.writes.length, 0);
  }
  const redirect = response('redirect', '/earth/', { 'content-type': 'text/html' }); Object.defineProperty(redirect, 'redirected', { value: true });
  const h = harness({ fetchImpl: async () => redirect }); const event = h.dispatch('/earth/', { mode: 'navigate' }); await event.result;
  assert.equal(h.writes.length, 0);
});
