import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEonetSnapshot, createEonetSnapshotReader, EONET_QUERY_URL, EONET_SNAPSHOT_URL,
  EONET_REFRESH_MS, EONET_LIVE_REFRESH_MS, EONET_MAX_AGE_MS, EONET_UPSTREAM_MAX_BYTES } from './eonet-snapshot.js';
const initial = Date.parse('2026-10-11T12:00:00.000Z');
const event = { id: 'EONET_1', title: 'Synthetic storm reference', closed: null,
  categories: [{ id: 'severeStorms' }], sources: [{ id: 'JTWC', url: 'https://www.metoc.navy.mil/jtwc/' }], geometry: [{ date: '2026-10-10T00:00:00Z' }] };
const snapshot = (at = initial, value = event) => createEonetSnapshot({ events: [value] }, { retrievedAt: new Date(at).toISOString(), nowMs: at });
const response = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const live = (value = event, headers) => response({ events: [value] }, headers);

test('twenty visitor queries coalesce one direct request without transmitting queries or coordinates', async () => {
  let calls = 0, writes = 0; const expected = await snapshot(), gate = Promise.withResolvers();
  const read = createEonetSnapshotReader({ now: () => initial,
    store: { async get() { return null; }, async put(key, saved) { if (key === 'eonet:snapshot') { assert.equal(saved.mode, 'live-eonet'); writes++; } } },
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, EONET_QUERY_URL); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Accept, 'application/json'); await gate.promise; return live();
    } });
  const work = Array.from({ length: 20 }, (_, i) => read({ category: i % 2 ? 'disasters' : 'all', q: `Private ${i}`, lat: 50, lon: 4 }));
  gate.resolve(); const results = await Promise.all(work); assert.equal(calls, 1); assert.equal(writes, 1);
  for (const result of results) {
    assert.equal(result.state.status, 'ready'); assert.equal(result.state.mode, 'live-eonet'); assert.equal(result.indexRecords.length, 1);
    assert.equal(result.indexSource.generation, expected.generation); assert.equal(result.state.refreshIntervalMs, 60000);
    assert.equal(result.records[0].sourceGeometryAt, '2026-10-10T00:00:00.000Z'); assert.equal(result.records[0].observedAt, null);
  }
  await read(); assert.equal(calls, 1);
});

test('country and non-disaster requests perform no direct, fallback or storage acquisition', async () => {
  const read = createEonetSnapshotReader({ fetchImpl() { assert.fail('Not-applicable fetch'); }, store: { get() { assert.fail('Not-applicable storage read'); } } });
  for (const filters of [{ country: 'UA', category: 'all' }, { category: 'economy' }, { category: 'geopolitics' }]) {
    const result = await read(filters); assert.equal(result.state.status, 'not-applicable'); assert.equal(result.state.countriesAvailable, false); assert.deepEqual(result.records, []);
  }
});

test('direct refresh waits sixty seconds; unchanged facts keep generation/geometry while actual new acquisition renews retrieval', async () => {
  let clock = initial, calls = 0;
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); clock += 25; return live(); } });
  const first = await read(); assert.equal(first.state.retrievedAt, new Date(initial + 25).toISOString());
  clock = initial + EONET_LIVE_REFRESH_MS - 1; await read(); assert.equal(calls, 1);
  clock = initial + EONET_LIVE_REFRESH_MS; const fresh = await read(); assert.equal(calls, 2); assert.equal(fresh.state.status, 'ready');
  assert.equal(fresh.indexSource.generation, first.indexSource.generation); assert.notEqual(fresh.indexSource.expiresAt, first.indexSource.expiresAt);
  assert.equal(fresh.records[0].sourceGeometryAt, first.records[0].sourceGeometryAt); assert.equal(fresh.state.retrievedAt, new Date(clock).toISOString());
});

test('cold outage coalesces one owned fallback without renewing original source dates or clearing live backoff', async () => {
  let clock = initial, directCalls = 0, fallbackCalls = 0; const value = await snapshot(initial - EONET_REFRESH_MS);
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => {
    if (url === EONET_QUERY_URL) { directCalls++; throw new Error('Synthetic outage'); }
    assert.equal(url, EONET_SNAPSHOT_URL); fallbackCalls++; return response(value);
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => read()));
  for (const result of results) {
    assert.equal(result.state.status, 'stale'); assert.equal(result.state.mode, 'scheduled-eonet-fallback'); assert.match(result.state.reason, /fallback.*original retrieval/);
    assert.equal(result.state.retrievedAt, value.retrievedAt); assert.equal(result.state.snapshotRetrievedAt, new Date(initial).toISOString());
    assert.equal(result.indexSource.expiresAt, new Date(initial - EONET_REFRESH_MS + EONET_MAX_AGE_MS).toISOString()); assert.equal(result.state.retryAt, initial + EONET_LIVE_REFRESH_MS);
  }
  assert.equal(directCalls, 1); assert.equal(fallbackCalls, 1); await read(); assert.equal(directCalls, 1);
  clock += EONET_LIVE_REFRESH_MS; await read(); assert.equal(directCalls, 2); assert.equal(fallbackCalls, 1);
});

test('later direct success replaces fallback with honest live provenance and unchanged fact generation', async () => {
  let clock = initial, failed = true, fallbackCalls = 0; const old = await snapshot(initial - EONET_REFRESH_MS);
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => {
    if (url === EONET_SNAPSHOT_URL) { fallbackCalls++; return response(old); }
    assert.equal(url, EONET_QUERY_URL); if (failed) throw new Error('Synthetic outage'); return live();
  } });
  const fallback = await read(); failed = false; clock += EONET_LIVE_REFRESH_MS; const fresh = await read();
  assert.equal(fresh.state.mode, 'live-eonet'); assert.equal(fresh.state.status, 'ready'); assert.equal(fresh.state.retryAt, null);
  assert.equal(fresh.state.retrievedAt, new Date(clock).toISOString()); assert.equal(fresh.indexSource.generation, fallback.indexSource.generation); assert.equal(fallbackCalls, 1);
});

test('restored live data observes minimum acquisition and persisted Retry-After across reader instances', async () => {
  let clock = initial, calls = 0; const values = new Map();
  const store = { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, structuredClone(value)); } };
  const fetchImpl = async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return calls === 1 ? live() : new Response('', { status: 429, headers: { 'retry-after': '7200' } }); };
  await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })();
  clock += 1000; await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })(); assert.equal(calls, 1);
  clock = initial + EONET_LIVE_REFRESH_MS; const stale = await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })();
  assert.equal(stale.state.status, 'stale'); assert.equal(stale.state.retryAt, clock + 7200000); assert.equal(calls, 2);
  clock += EONET_LIVE_REFRESH_MS; const retained = await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })();
  assert.equal(calls, 2); assert.equal(retained.state.retryAt, stale.state.retryAt); assert.equal(retained.state.retrievedAt, new Date(initial).toISOString());
});

test('shared atomic lease prevents two independent readers from fanning out and the loser restores the resulting generation', async () => {
  let calls = 0; const values = new Map(), gate = Promise.withResolvers(); let until = 0;
  const store = { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, structuredClone(value)); },
    async claim(key, at, wait) { assert.equal(key, 'eonet:live'); assert.equal(wait, 60000); if (until > at) return false; until = at + wait; return true; } };
  const fetchImpl = async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); await gate.promise; return live(); };
  const a = createEonetSnapshotReader({ now: () => initial, store, fetchImpl }), b = createEonetSnapshotReader({ now: () => initial, store, fetchImpl });
  const first = a(); const second = await b(); assert.equal(second.state.status, 'busy'); assert.equal(second.records.length, 0); assert.equal(calls, 1);
  gate.resolve(); const winner = await first; const restored = await b(); assert.equal(calls, 1);
  assert.equal(restored.indexSource.generation, winner.indexSource.generation); assert.equal(restored.state.retrievedAt, winner.state.retrievedAt); assert.equal(restored.state.status, 'ready');
});

test('provider retry policy without any usable snapshot suppresses a new instance rather than retrying a cold outage', async () => {
  let clock = initial, calls = 0; const values = new Map();
  const store = { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, structuredClone(value)); } };
  const fetchImpl = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '7200' } }); };
  const first = await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })();
  assert.equal(calls, 2); assert.equal(first.records.length, 0); assert.equal(first.state.retryAt, clock + 7200000);
  clock += EONET_LIVE_REFRESH_MS;
  const second = await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })();
  assert.equal(calls, 2); assert.equal(second.state.status, 'unavailable'); assert.equal(second.state.retrievedAt, null); assert.equal(second.state.retryAt, first.state.retryAt);
});

test('a newer shared successful attempt suppresses another live instance even when its own last copy is older', async () => {
  let clock = initial, calls = 0; const values = new Map();
  const store = { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, structuredClone(value)); } };
  const fetchImpl = async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return live(); };
  const earlier = createEonetSnapshotReader({ now: () => clock, store, fetchImpl }); await earlier();
  clock += EONET_LIVE_REFRESH_MS; await createEonetSnapshotReader({ now: () => clock, store, fetchImpl })(); assert.equal(calls, 2);
  clock += 1000; await earlier(); assert.equal(calls, 2);
});

test('stalled/failed lease fails closed with bounded busy state and no source or fallback fetch', { timeout: 1000 }, async () => {
  for (const claim of [() => new Promise(() => {}), async () => { throw new Error('Synthetic storage failure'); }, async () => false]) {
    const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10, store: { async get() { return null; }, claim }, fetchImpl() { assert.fail('Unclaimed fetch'); } });
    const result = await read(); assert.equal(result.state.status, 'busy'); assert.equal(result.state.retrievedAt, null); assert.match(result.state.reason, /no extra source request/);
  }
});

test('legacy scheduled storage never suppresses first direct check and exact 24-hour expiry withholds source records', async () => {
  let clock = initial + EONET_LIVE_REFRESH_MS, directCalls = 0; const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => clock, store: { async get(key) { return key === 'eonet:snapshot' ? { acquiredAt: clock, snapshot: value } : null; } },
    fetchImpl: async (url) => { if (url === EONET_QUERY_URL) directCalls++; throw new Error('Synthetic outage'); } });
  const stale = await read(); assert.equal(stale.state.status, 'stale'); assert.equal(stale.records.length, 1); assert.equal(directCalls, 1); assert.equal(stale.state.retrievedAt, value.retrievedAt);
  clock = initial + EONET_MAX_AGE_MS; const expired = await read(); assert.equal(expired.state.status, 'unavailable'); assert.equal(expired.records.length, 0); assert.match(expired.state.reason, /24-hour/);
});

test('rate-limit response body is canceled and preserves previous live dates with no extra acquisition in Retry-After', async () => {
  let clock = initial, calls = 0, cancelled = 0;
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => {
    calls++; assert.equal(url, EONET_QUERY_URL); return calls === 1 ? live() : new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429, headers: { 'retry-after': '7200' } });
  } });
  const first = await read(); clock += EONET_LIVE_REFRESH_MS; const stale = await read();
  assert.equal(stale.state.status, 'stale'); assert.equal(stale.state.retryAt, clock + 7200000); assert.equal(stale.state.retrievedAt, first.state.retrievedAt); assert.equal(cancelled, 1);
  clock += EONET_REFRESH_MS; await read({ q: 'Different local query' }); assert.equal(calls, 2);
});

test('RSS header compatibility requires JSON; XML, size excess, invalid dates, unknown MIME and unexpected 304 cannot replace live facts', async () => {
  const oversized = Array.from({ length: 60 }, (_, i) => ({ ...event, id: `EONET_${i + 1}`, title: 'x'.repeat(160),
    sources: Array.from({ length: 4 }, (_, j) => ({ id: `source${j}`, url: `https://example.com/${'a'.repeat(480)}${j}` })) }));
  for (const bad of [
    () => new Response('<rss>Private raw content</rss>', { headers: { 'content-type': 'application/rss+xml' } }),
    () => new Response(new Uint8Array(EONET_UPSTREAM_MAX_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    () => response({ events: oversized }), () => live({ ...event, geometry: [{ date: '2026-10-12T00:00:00Z' }] }),
    () => live(event, { 'content-type': 'application/rss+xml-extra' }), () => new Response(null, { status: 304 }),
  ]) {
    let clock = initial, calls = 0;
    const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return calls === 1 ? live(event, { 'content-type': 'application/rss+xml; charset=utf-8' }) : bad(); } });
    const first = await read(); assert.equal(first.state.status, 'ready'); clock += EONET_LIVE_REFRESH_MS; const stale = await read();
    assert.equal(stale.state.status, 'stale'); assert.equal(stale.indexSource.generation, first.indexSource.generation); assert.equal(stale.state.retrievedAt, first.state.retrievedAt);
    assert.equal(stale.records[0].title, event.title); assert.equal(calls, 2); assert.equal(JSON.stringify(stale.state).includes('Private raw content'), false); await read(); assert.equal(calls, 2);
  }
});

test('failed fallback retries are separately bounded; no metadata acquisition date is invented', async () => {
  let clock = initial, directCalls = 0, fallbackCalls = 0;
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => {
    if (url === EONET_QUERY_URL) { directCalls++; throw new Error('Synthetic outage'); }
    assert.equal(url, EONET_SNAPSHOT_URL); fallbackCalls++; return new Response('', { status: 429, headers: { 'retry-after': '7200' } });
  } });
  const empty = await read(); assert.equal(empty.state.status, 'unavailable'); assert.equal(empty.state.retrievedAt, null);
  clock += EONET_LIVE_REFRESH_MS; await read(); clock += 2 * EONET_LIVE_REFRESH_MS; await read(); assert.equal(directCalls, 3); assert.equal(fallbackCalls, 1);
});

test('valid empty direct metadata retires old candidates without invoking fallback', async () => {
  let clock = initial, calls = 0; const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return calls === 1 ? live() : response({ events: [] }); } });
  assert.equal((await read()).records.length, 1); clock += EONET_LIVE_REFRESH_MS; const empty = await read();
  assert.deepEqual(empty.records, []); assert.equal(empty.state.status, 'ready'); assert.equal(empty.state.retainedEvents, 0); assert.equal(calls, 2);
});

test('stalled optional storage reads/writes cannot pin shared direct acquisition', { timeout: 1000 }, async () => {
  for (const stalled of ['read', 'write']) {
    let calls = 0, gets = 0, writes = 0; const expected = await snapshot();
    const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10,
      store: { get() { if (stalled === 'read') return new Promise(() => {}); gets++; return null; }, put(key, saved) {
        if (key === 'eonet:snapshot') { writes++; assert.equal(saved.snapshot.generation, expected.generation); }
        return stalled === 'write' ? new Promise(() => {}) : undefined;
      } }, fetchImpl: async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return live(); } });
    const results = await Promise.all(Array.from({ length: 8 }, () => read())); assert.equal(calls, 1); assert.equal(writes, 1);
    for (const result of results) { assert.equal(result.state.status, 'ready'); assert.equal(result.indexSource.generation, expected.generation); }
    await read(); assert.equal(calls, 1);
  }
});

test('late scheduled restoration cannot overwrite a newer direct generation after the optional storage deadline', { timeout: 1000 }, async () => {
  let calls = 0; const delayedGet = Promise.withResolvers(), old = await snapshot(initial - EONET_REFRESH_MS), freshEvent = { ...event, title: 'Newer synthetic reference' };
  const expected = await snapshot(initial, freshEvent);
  const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10, store: { get(key) { return key === 'eonet:snapshot' ? delayedGet.promise : null; } },
    fetchImpl: async (url) => { calls++; assert.equal(url, EONET_QUERY_URL); return live(freshEvent); } });
  assert.equal((await read()).indexSource.generation, expected.generation); delayedGet.resolve({ acquiredAt: initial - EONET_REFRESH_MS, snapshot: old });
  await new Promise((resolve) => setImmediate(resolve)); const retained = await read(); assert.equal(calls, 1); assert.equal(retained.indexSource.generation, expected.generation); assert.equal(retained.state.mode, 'live-eonet');
});
