import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { ofmCacheKind, renderServiceWorker } from '../scripts/service-worker-runtime.mjs';

const origin = 'https://example.com', provider = 'https://tiles.openfreemap.org', metadata = provider + '/planet';
const tile = (x = 0) => `${provider}/planet/20261004_113936_pt/14/${x}/5496.pbf`;
const tileJson = () => JSON.stringify({ tiles: [provider + '/planet/20261004_113936_pt/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 });
function response(url, body, headers = {}, extra = {}) {
  const value = new Response(body, { headers: { 'content-type': url === metadata ? 'application/json' : 'application/vnd.mapbox-vector-tile', 'cache-control': 'public, max-age=31536000', ...headers } });
  Object.defineProperty(value, 'url', { value: url });
  for (const [key, item] of Object.entries(extra)) Object.defineProperty(value, key, { value: item });
  return value;
}
function harness({ online = true, fetchImpl, caches = new Map(), delayPut } = {}) {
  const listeners = new Map(), fetches = [], reads = [], writes = [], messages = [];
  const cache = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const entries = caches.get(name), url = (request) => typeof request === 'string' ? request : request.url;
    return {
      async match(request) { reads.push([name, url(request)]); return entries.get(url(request))?.clone(); },
      async put(request, result) { writes.push([name, url(request)]); if (delayPut) await delayPut(); entries.set(url(request), result.clone()); },
      async keys() { return [...entries.keys()].map(key => new Request(key)); },
      async delete(request) { return entries.delete(url(request)); },
    };
  };
  const self = { navigator: { onLine: online }, addEventListener: (name, fn) => listeners.set(name, fn), clients: { async get() { return { postMessage(message) { messages.push(message); } }; } } };
  const context = { self, location: { origin }, URL, Request, Response, Headers, AbortController, TextDecoder, TextEncoder, Uint8Array, setTimeout, clearTimeout, caches: { async open(name) { return cache(name); } }, fetch(request, options) { fetches.push([request.url || request, options]); return fetchImpl(request, options); } };
  vm.runInNewContext(renderServiceWorker({ critical: ['/earth/', '/earth/assets/main-one.js'], version: 'fixture', scope: '/earth/' }), context);
  function dispatch(url, { headers = {}, credentials = 'omit', mode = 'cors' } = {}) {
    let result; const pending = [];
    listeners.get('fetch')({ request: { method: 'GET', url, credentials, mode, headers: new Headers(headers) }, clientId: 'qa', respondWith(work) { result = work; }, waitUntil(work) { pending.push(work); } });
    return { get result() { return result; }, async completed() { const value = await result; await Promise.all(pending); return value; }, pending };
  }
  return { dispatch, caches, fetches, reads, writes, messages, self };
}
async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Network delivery waited for map storage')), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('only approved metadata and in-range dated native tiles enter the offline policy', () => {
  assert.equal(ofmCacheKind(new URL(metadata)), 'metadata'); assert.equal(ofmCacheKind(new URL(tile(8389))), 'tile');
  assert.equal(ofmCacheKind(new URL(provider + '/planet/20261004_113936_pt/0/0/0.pbf')), 'tile');
  for (const url of [tile().replace('https:', 'http:'), tile().replace('tiles.openfreemap.org', 'elsewhere.example'), tile() + '?key=value', tile() + '#extra', tile().replace('/14/', '/15/'), tile(16384), tile().replace('/5496.pbf', '/16384.pbf'), tile().replace('/14/', '/014/'), tile().replace('20261004_113936_pt', 'unfamiliar-version'), metadata + '/', provider + '/api/private', tile().replace('https://', 'https://user@')]) assert.equal(ofmCacheKind(new URL(url)), null, url);
});

test('online OFM is HTTP-first with no CacheStorage read on its response path, and only visited files are stored', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ fetchImpl: async request => response(request.url, 'actual tile'), delayPut: () => gate });
  assert.equal(h.fetches.length, 0); assert.equal(h.caches.size, 0);
  const event = h.dispatch(tile(8389)), result = await bounded(event.result);
  assert.equal(await result.text(), 'actual tile'); assert.equal(h.fetches.length, 1); assert.equal(h.fetches[0][1].cache, 'default');
  // Only the tiny ledger is read in background; a cached tile is never consulted while online.
  assert.equal(h.reads.some(([, url]) => url === tile(8389)), false);
  release(); await Promise.all(event.pending);
  assert.equal(h.caches.get('earth-observer-ofm-v1').has(tile(8389)), true);
  assert.equal(h.caches.get('earth-observer-ofm-v1').size, 2); // visited tile + small budget ledger
  assert.equal(h.fetches.length, 1); // no neighbouring tiles or metadata were prefetched
});

test('visited metadata and tiles restore offline across a worker restart; unknown tiles fail without network or bulk download', async () => {
  const h = harness({ fetchImpl: async request => response(request.url, request.url === metadata ? tileJson() : 'observed tile') });
  await h.dispatch(metadata).completed(); await h.dispatch(tile(8389)).completed();
  const offline = harness({ online: false, caches: h.caches, fetchImpl() { assert.fail('Offline transport'); } });
  assert.equal((await (await offline.dispatch(metadata).completed()).json()).tiles[0], JSON.parse(tileJson()).tiles[0]);
  assert.equal(await (await offline.dispatch(tile(8389)).completed()).text(), 'observed tile');
  await assert.rejects(offline.dispatch(tile(8390)).result, /Offline/); assert.equal(offline.fetches.length, 0);
  assert.equal(offline.messages.length, 1); assert.match(offline.messages[0].message, /coverage may be incomplete offline/);
});

test('64 entries includes the budget ledger and retained TileJSON; oldest tile entries are evicted without deleting metadata', async () => {
  const h = harness({ fetchImpl: async request => response(request.url, request.url === metadata ? tileJson() : 'tile') });
  await h.dispatch(metadata).completed();
  for (let x = 0; x < 65; x++) await h.dispatch(tile(x)).completed();
  const entries = h.caches.get('earth-observer-ofm-v1'); assert.equal(entries.size, 64); assert.equal(entries.has(metadata), true);
  assert.equal(entries.has(tile(0)), false); assert.equal(entries.has(tile(64)), true);
});

test('the 16 MiB budget counts real decoded tile bytes and the persistent ledger across restarts', async () => {
  const body = new Uint8Array(4 * 1024 * 1024);
  const h = harness({ fetchImpl: async request => response(request.url, request.url === metadata ? tileJson() : body) });
  await h.dispatch(metadata).completed(); for (let x = 0; x < 4; x++) await h.dispatch(tile(x)).completed();
  let bytes = 0; for (const result of h.caches.get('earth-observer-ofm-v1').values()) bytes += (await result.clone().arrayBuffer()).byteLength;
  assert.ok(bytes <= 16 * 1024 * 1024); assert.equal(h.caches.get('earth-observer-ofm-v1').has(tile(0)), false);
  const restarted = harness({ caches: h.caches, fetchImpl: async request => response(request.url, body) });
  await restarted.dispatch(tile(4)).completed(); bytes = 0;
  for (const result of h.caches.get('earth-observer-ofm-v1').values()) bytes += (await result.clone().arrayBuffer()).byteLength;
  assert.ok(bytes <= 16 * 1024 * 1024); assert.equal(h.caches.get('earth-observer-ofm-v1').has(metadata), true);
});

test('opaque, redirected, private/no-store, credentialed and malformed responses cannot populate the map bucket', async () => {
  const cases = [
    response(tile(), 'tile', {}, { type: 'opaque' }), response(tile(), 'tile', {}, { redirected: true }),
    response(tile(), 'tile', { 'cache-control': 'private' }), response(tile(), 'tile', { 'cache-control': 'no-store' }),
    response(tile(), 'tile', { 'set-cookie': 'secret=1' }), response(tile(), '<html>error</html>', { 'content-type': 'text/html' }),
    response(metadata, '{invalid'), response(metadata, JSON.stringify({ tiles: ['https://elsewhere.example/{z}/{x}/{y}.pbf'], maxzoom: 14 })),
  ];
  for (const value of cases) {
    const h = harness({ fetchImpl: async () => value }); const event = h.dispatch(value.url); await event.completed(); assert.equal(h.writes.length, 0);
  }
  const h = harness({ fetchImpl() { assert.fail('Protected request interception'); } });
  for (const options of [{ headers: { authorization: 'Bearer qa' } }, { credentials: 'include' }]) assert.equal(h.dispatch(tile(), options).result, undefined);
  assert.equal(h.reads.length, 0);
});

test('chunked oversized tiles are never cached and decoded responses do not retain a gzip content-encoding header', async () => {
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)); controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.close(); } });
  const h = harness({ fetchImpl: async request => response(request.url, oversized) });
  const event = h.dispatch(tile()); const live = await event.result; assert.equal((await live.arrayBuffer()).byteLength, 5 * 1024 * 1024); await Promise.all(event.pending); assert.equal(h.writes.length, 0);
  const gzip = harness({ fetchImpl: async request => response(request.url, 'decoded tile bytes', { 'content-encoding': 'gzip', 'content-length': '8' }) });
  await gzip.dispatch(tile()).completed(); const saved = gzip.caches.get('earth-observer-ofm-v1').get(tile());
  assert.equal(saved.headers.has('content-encoding'), false); assert.equal(saved.headers.get('content-length'), '18');
  assert.equal(await saved.clone().text(), 'decoded tile bytes');
});

test('background map copies are bounded without delaying live requests, even while storage is slow', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ fetchImpl: async request => response(request.url, 'tile'), delayPut: () => gate });
  const events = Array.from({ length: 10 }, (_, index) => h.dispatch(tile(index)));
  const live = await bounded(Promise.all(events.map(event => event.result)));
  assert.equal(live.length, 10); for (const result of live) assert.equal(await result.text(), 'tile');
  release(); await Promise.all(events.flatMap(event => event.pending));
  assert.equal(h.fetches.length, 10); assert.equal(h.caches.get('earth-observer-ofm-v1').size, 9); // at most eight copies + ledger
});

test('a partial quota failure cannot reject live data or leave unaccounted tile copies after the next successful write', async () => {
  let writes = 0;
  const h = harness({ fetchImpl: async request => response(request.url, 'tile'), delayPut: () => { if (++writes === 2) throw new Error('Quota failure during ledger write'); } });
  assert.equal(await (await h.dispatch(tile(1)).completed()).text(), 'tile');
  assert.equal(await (await h.dispatch(tile(2)).completed()).text(), 'tile');
  const entries = h.caches.get('earth-observer-ofm-v1');
  assert.equal(entries.has(tile(1)), false); assert.equal(entries.has(tile(2)), true); assert.equal(entries.size, 2);
});
