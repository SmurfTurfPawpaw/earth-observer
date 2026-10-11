import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from './browser-store.js';
import { createCachedFetch } from './cached-fetch.js';

const url = '/api/flights?lat=4&lon=5';
const response = (value) => new Response(JSON.stringify({ value }), { headers: { 'content-type': 'application/json' } });

test('explicit live revalidation bypasses a fresh snapshot and persists the newer successful response', async () => {
  let calls = 0, clock = 10000;
  const store = createBrowserStore(null), endpoint = '/api/intelligence?category=all';
  const cached = createCachedFetch({ store, now: () => clock, fetchImpl: async (_url, init) => {
    calls++; if (calls > 1) assert.equal(init.cache, 'no-cache'); return response(calls);
  } });
  assert.equal((await (await cached(endpoint)).json()).value, 1);
  clock++;
  assert.equal((await (await cached(endpoint)).json()).value, 1);
  assert.equal((await (await cached(endpoint, { cache: 'no-cache' })).json()).value, 2);
  assert.equal((await (await cached(endpoint)).json()).value, 2);
  assert.equal(calls, 2);
  cached.destroy();
});

test('a producer check waits out the pre-publication transport and coalesces one subsequent generation', async () => {
  let clock = 10000, calls = 0;
  const old = Promise.withResolvers(), began = Promise.withResolvers(), newer = Promise.withResolvers(), nextBegan = Promise.withResolvers();
  const endpoint = '/api/aircraft/observations?lat=50.85&lon=4.35&radiusKm=50';
  const cached = createCachedFetch({ store: createBrowserStore(null), now: () => clock, fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return response('initial');
    if (calls === 2) { began.resolve(); return old.promise; }
    assert.equal(init.cache, 'no-cache'); nextBegan.resolve(); return newer.promise;
  } });
  await cached(endpoint); clock += 10001;
  assert.equal((await (await cached(endpoint)).json()).value, 'initial'); await began.promise;
  const forced = cached(endpoint, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } });
  const shared = cached(endpoint, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 2);
  old.resolve(response('old')); await nextBegan.promise;
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 3);
  newer.resolve(response('new'));
  assert.equal((await (await forced).json()).value, 'new');
  assert.equal((await (await shared).json()).value, 'new');
  assert.equal((await (await cached(endpoint)).json()).value, 'new');
  assert.equal(calls, 3); cached.destroy();
});

test('offline live checks preserve the saved copy instead of discarding it or contacting upstream', async () => {
  let connected = true, calls = 0;
  const cached = createCachedFetch({ store: createBrowserStore(null), online: () => connected,
    fetchImpl: async () => { calls++; return response(3); } });
  await cached('/api/intelligence'); connected = false;
  const saved = await cached('/api/intelligence', { cache: 'no-cache' });
  assert.equal(saved.headers.get('x-browser-cache'), 'OFFLINE');
  assert.equal((await saved.json()).value, 3); assert.equal(calls, 1);
  cached.destroy();
});

test('a failed live revalidation leaves dated storage intact and rejects rather than claiming a fresh check', async () => {
  let calls = 0;
  const store = createBrowserStore(null);
  const cached = createCachedFetch({ store, now: () => 10000, fetchImpl: async () => {
    if (++calls > 1) throw new Error('Transport unavailable'); return response(7);
  } });
  await cached('/api/intelligence');
  await assert.rejects(cached('/api/intelligence', { cache: 'no-cache' }), /Transport unavailable/);
  const saved = await store.get('response:http://localhost/api/intelligence');
  assert.equal(saved.at, 10000);
  assert.equal((await (await cached('/api/intelligence')).json()).value, 7);
  assert.equal(calls, 2); cached.destroy();
});

test('one cancelled caller cannot cancel another caller sharing the same feed request', async () => {
  const started = Promise.withResolvers(), upstream = Promise.withResolvers();
  let calls = 0, transport;
  const fetch = createCachedFetch({ store: createBrowserStore(null), fetchImpl: (_url, { signal }) => {
    calls++; transport = signal; started.resolve(); return upstream.promise;
  } });
  const one = new AbortController(), two = new AbortController();
  const cancelled = fetch(url, { signal: one.signal });
  const retained = fetch(url, { signal: two.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  await started.promise;
  // The second cache lookup is ordered behind the first; let it join first.
  await new Promise((resolve) => setImmediate(resolve));
  one.abort(); await rejected;
  assert.equal(transport.aborted, false);
  upstream.resolve(response(42));
  assert.equal((await (await retained).json()).value, 42);
  assert.equal(calls, 1);
  fetch.destroy();
});

test('a joining caller cancels promptly without interrupting the first caller', async () => {
  const started = Promise.withResolvers(), upstream = Promise.withResolvers();
  let transport;
  const fetch = createCachedFetch({ store: createBrowserStore(null), fetchImpl: (_url, { signal }) => {
    transport = signal; started.resolve(); return upstream.promise;
  } });
  const one = fetch(url), controller = new AbortController();
  const two = fetch(url, { signal: controller.signal });
  const rejected = assert.rejects(two, { name: 'AbortError' });
  await started.promise; await new Promise((resolve) => setImmediate(resolve));
  controller.abort(); await rejected;
  assert.equal(transport.aborted, false);
  upstream.resolve(response(7));
  assert.equal((await (await one).json()).value, 7); fetch.destroy();
});

test('the last cancelled caller stops the shared transport and a replacement request can start', async () => {
  const started = Promise.withResolvers(); let calls = 0, firstSignal;
  const fetch = createCachedFetch({ store: createBrowserStore(null), fetchImpl: (_url, { signal }) => {
    calls++;
    if (calls > 1) return Promise.resolve(response(9));
    firstSignal = signal; started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController(), request = fetch(url, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started.promise; controller.abort(); await rejected;
  assert.equal(firstSignal.aborted, true);
  assert.equal((await (await fetch(url)).json()).value, 9);
  assert.equal(calls, 2); fetch.destroy();
});

test('cancellation during a delayed cache lookup returns immediately and cannot start a late request', async () => {
  const lookup = Promise.withResolvers(); let calls = 0;
  const fetch = createCachedFetch({ store: { get: () => lookup.promise }, fetchImpl: async () => { calls++; return response(1); } });
  const controller = new AbortController();
  const request = fetch(url, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort(); await rejected;
  lookup.resolve(undefined); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0); fetch.destroy();
});

test('workspace teardown promptly rejects consumers even when a custom transport ignores abort', async () => {
  const started = Promise.withResolvers(), upstream = Promise.withResolvers();
  const fetch = createCachedFetch({ store: createBrowserStore(null), fetchImpl: async () => { started.resolve(); return upstream.promise; } });
  const request = fetch(url), rejected = assert.rejects(request, { name: 'AbortError' });
  await started.promise; fetch.destroy(); await rejected;
  upstream.resolve(response(1)); await new Promise((resolve) => setImmediate(resolve));
});

test('failing cache reads, writes and trimming never reject a successful HTTP response', async () => {
  const store = { get: async () => { throw new Error('read unavailable'); }, put: async () => { throw new Error('quota exceeded'); }, all: async () => { throw new Error('read unavailable'); } };
  const fetch = createCachedFetch({ store, fetchImpl: async () => response(5) });
  assert.equal((await (await fetch(url)).json()).value, 5); fetch.destroy();
  const trimFailure = createCachedFetch({ store: { ...store, put: async () => {} }, fetchImpl: async () => response(6) });
  assert.equal((await (await trimFailure(url)).json()).value, 6); trimFailure.destroy();
});

test('chunked oversized cache copies stop at the cap without delaying or truncating the feed caller', async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024).fill(32);
  let puts = 0;
  const fetch = createCachedFetch({ store: { get: async () => undefined, put: async () => puts++, all: async () => [] }, fetchImpl: async () =>
    new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'application/json' } }) });
  const live = await fetch(url);
  assert.equal((await live.arrayBuffer()).byteLength, bytes.byteLength);
  assert.equal(puts, 0); fetch.destroy();
});

test('cache time records HTTP contact rather than delayed persistence completion', async () => {
  let clock = 10000;
  const records = new Map();
  const store = { get: async (key) => records.get(key), put: async (key, record) => { clock += 1000; records.set(key, record); }, all: async () => [] };
  const fetch = createCachedFetch({ store, now: () => clock, fetchImpl: async () => response(1) });
  await fetch(url);
  const cached = await fetch(url);
  assert.equal(cached.headers.get('x-browser-cached-at'), '10000');
  assert.equal(cached.headers.get('x-browser-cache-age-ms'), '1000'); fetch.destroy();
});

test('corrupt snapshots cannot block network recovery and credentials bypass snapshots', async () => {
  let calls = 0;
  const store = { get: async () => ({ at: 10000, status: 200, body: new ArrayBuffer(1), headers: [['invalid header', 'value']] }), put: async () => {}, all: async () => [] };
  const fetch = createCachedFetch({ store, now: () => 10000, fetchImpl: async () => { calls++; return response(calls); } });
  assert.equal((await (await fetch(url)).json()).value, 1);
  await fetch(url, { credentials: 'include' }); await fetch(url, { credentials: 'include' });
  await fetch(url, { cache: 'no-store' });
  assert.equal(calls, 4); fetch.destroy();
});

test('cache pruning requests its response namespace and leaves notebook and scene records intact', async () => {
  const store = createBrowserStore(null), prefixes = [], all = store.all;
  store.all = (prefix) => { prefixes.push(prefix); return all(prefix); };
  const oldKey = 'response:http://localhost/api/flights?lat=0&lon=0';
  await store.put(oldKey, { at: 1, status: 200, body: new ArrayBuffer(4), headers: [], expire: 1 });
  await store.put('evidence:photo', { photo: new Blob(['private photograph']) });
  await store.put('scene:preview', { body: new ArrayBuffer(8) });
  const removed = Promise.withResolvers(), originalDelete = store.delete;
  store.delete = async (key) => { const result = await originalDelete(key); removed.resolve(key); return result; };
  const fetch = createCachedFetch({ store, now: () => 100_000, fetchImpl: async () => response(12) });
  assert.equal((await (await fetch(url)).json()).value, 12);
  assert.equal(await removed.promise, oldKey);
  assert.deepEqual(prefixes, ['response:']);
  assert.equal(await store.get(oldKey), undefined);
  assert.equal((await store.get('evidence:photo')).photo.size, 18);
  assert.equal((await store.get('scene:preview')).body.byteLength, 8);
  assert.equal((await store.get(`response:http://localhost${url}`)).status, 200);
  fetch.destroy();
});

test('cache pruning remains compatible with injected legacy stores that ignore the prefix argument', async () => {
  const removed = Promise.withResolvers(); let unrelatedReads = 0;
  const unrelated = { key: 'evidence:private-photo', get body() { unrelatedReads++; throw new Error('Unrelated photo was touched'); } };
  const prefixes = [];
  const store = { get: async () => undefined, put: async () => {}, all: async (prefix) => {
    prefixes.push(prefix);
    return [unrelated, { key: 'response:expired', at: 1, status: 200, body: new ArrayBuffer(1), headers: [], expire: 1 }];
  }, delete: async (key) => removed.resolve(key) };
  const fetch = createCachedFetch({ store, now: () => 100_000, fetchImpl: async () => response(3) });
  assert.equal((await (await fetch(url)).json()).value, 3);
  assert.equal(await removed.promise, 'response:expired');
  assert.deepEqual(prefixes, ['response:']);
  assert.equal(unrelatedReads, 0); fetch.destroy();
});
