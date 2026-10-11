import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEonetSnapshot, createEonetSnapshotReader, EONET_QUERY_URL, EONET_SNAPSHOT_URL, EONET_REFRESH_MS, EONET_MAX_AGE_MS, EONET_SNAPSHOT_MAX_BYTES } from './eonet-snapshot.js';
const initial = Date.parse('2026-10-11T12:00:00.000Z');
const event = { id: 'EONET_1', title: 'Synthetic storm reference', closed: null,
  categories: [{ id: 'severeStorms', title: 'Severe Storms' }], sources: [{ id: 'JTWC', url: 'https://www.metoc.navy.mil/jtwc/' }], geometry: [{ date: '2026-10-10T00:00:00Z' }] };
const snapshot = (at = initial) => createEonetSnapshot({ events: [event] }, { retrievedAt: new Date(at).toISOString(), nowMs: at });
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('different visitor queries share one release read and return the same complete bounded candidate set', async () => {
  let calls = 0, writes = 0; const value = await snapshot(), gate = Promise.withResolvers();
  const read = createEonetSnapshotReader({ now: () => initial, store: { async get() { return null; }, async put(key) { assert.equal(key, 'eonet:snapshot'); writes++; } },
    fetchImpl: async (url) => { calls++; assert.equal(url, EONET_SNAPSHOT_URL); assert.notEqual(url, EONET_QUERY_URL); await gate.promise; return response(value); } });
  const work = Array.from({ length: 20 }, (_, index) => read({ category: index % 2 ? 'disasters' : 'all', q: `Query ${index}` }));
  await Promise.resolve(); await Promise.resolve(); gate.resolve();
  const results = await Promise.all(work);
  assert.equal(calls, 1); assert.equal(writes, 1);
  for (const result of results) { assert.equal(result.state.status, 'ready'); assert.equal(result.indexRecords.length, 1); assert.equal(result.indexSource.generation, value.generation); }
  await read(); assert.equal(calls, 1);
});

test('country and unrelated category requests are honestly not applicable and perform no acquisition', async () => {
  const read = createEonetSnapshotReader({ fetchImpl() { assert.fail('Not-applicable fetch'); }, store: { get() { assert.fail('Not-applicable storage read'); } } });
  for (const filters of [{ country: 'UA', category: 'all' }, { category: 'economy' }, { category: 'geopolitics' }]) {
    const result = await read(filters); assert.equal(result.state.status, 'not-applicable'); assert.equal(result.state.countriesAvailable, false);
    assert.equal(result.records.length, 0); assert.equal(result.indexRecords.length, 0);
  }
});

test('re-reading an unchanged release does not relabel its original retrieval as fresh', async () => {
  let clock = initial, calls = 0, value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async () => { calls++; return response(value); } });
  const first = await read(); clock += EONET_REFRESH_MS;
  const unchanged = await read(); assert.equal(calls, 2); assert.equal(unchanged.state.status, 'stale');
  assert.equal(unchanged.state.retrievedAt, first.state.retrievedAt); assert.notEqual(unchanged.state.snapshotRetrievedAt, first.state.snapshotRetrievedAt);
  assert.equal(unchanged.indexSource.generation, first.indexSource.generation); assert.equal(unchanged.indexSource.expiresAt, first.indexSource.expiresAt);
  clock += EONET_REFRESH_MS; value = await snapshot(clock);
  const refreshed = await read(); assert.equal(refreshed.state.status, 'ready'); assert.equal(refreshed.indexSource.generation, first.indexSource.generation);
  assert.notEqual(refreshed.indexSource.expiresAt, first.indexSource.expiresAt);
});

test('persistent last-good metadata survives an outage with original dates and retires at exact expiry', async () => {
  let clock = initial + EONET_REFRESH_MS, calls = 0;
  const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => clock, store: { async get() { return { acquiredAt: initial, snapshot: value }; }, async put() {} },
    fetchImpl: async () => { calls++; throw new Error('Synthetic outage'); } });
  const stale = await read(); assert.equal(stale.state.status, 'stale'); assert.equal(stale.indexRecords.length, 1);
  assert.equal(stale.state.retrievedAt, value.retrievedAt); assert.equal(stale.state.snapshotRetrievedAt, value.retrievedAt);
  await read(); assert.equal(calls, 1);
  clock = initial + EONET_MAX_AGE_MS;
  const expired = await read(); assert.equal(expired.state.status, 'unavailable'); assert.equal(expired.indexRecords.length, 0);
  assert.match(expired.state.reason, /24-hour/); assert.equal(expired.state.retrievedAt, value.retrievedAt);
});

test('malformed and oversized release bodies never replace last-good metadata; failures coalesce/back off', async () => {
  let clock = initial, calls = 0; const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async () => {
    calls++; return calls === 1 ? response(value) : new Response('x'.repeat(EONET_SNAPSHOT_MAX_BYTES + 1));
  } });
  await read(); clock += EONET_REFRESH_MS;
  const stale = await read(); assert.equal(stale.state.status, 'stale'); assert.equal(stale.records[0].title, event.title);
  await read(); assert.equal(calls, 2); assert.ok(stale.state.retryAt > clock);
  const invalid = createEonetSnapshotReader({ now: () => clock, store: { async get() { return { acquiredAt: clock, snapshot: { ...value, generation: 'f'.repeat(64) } }; } }, fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal((await invalid()).state.status, 'unavailable');
});

test('release rate-limit Retry-After cancels the body, retains last-good dates and pauses shared acquisition', async () => {
  let clock = initial, calls = 0, cancelled = 0; const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => clock, fetchImpl: async () => {
    calls++; return calls === 1 ? response(value) : new Response(new ReadableStream({ cancel() { cancelled++; } }),
      { status: 429, headers: { 'retry-after': '7200' } });
  } });
  await read(); clock += EONET_REFRESH_MS;
  const stale = await read(); assert.equal(stale.state.status, 'stale'); assert.equal(stale.state.retryAt, clock + 7200000);
  assert.equal(stale.state.retrievedAt, value.retrievedAt); assert.match(stale.state.reason, /429/); assert.equal(cancelled, 1);
  clock += 1800000; await read({ q: 'Different local query' }); assert.equal(calls, 2);
});

test('a never-settling optional storage read times out and shared callers recover from the release', { timeout: 1000 }, async () => {
  let calls = 0, gets = 0; const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10,
    store: { get() { gets++; return new Promise(() => {}); } },
    fetchImpl: async () => { calls++; return response(value); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => read()));
  assert.equal(gets, 1); assert.equal(calls, 1);
  for (const result of results) { assert.equal(result.state.status, 'ready'); assert.equal(result.indexSource.generation, value.generation); }
  await read(); assert.equal(gets, 1); assert.equal(calls, 1);
});

test('a never-settling optional storage write cannot pin coalesced requests or hide the acquired snapshot', { timeout: 1000 }, async () => {
  let calls = 0, writes = 0; const value = await snapshot();
  const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10,
    store: { async get() { return null; }, put(key, saved) {
      writes++; assert.equal(key, 'eonet:snapshot'); assert.equal(saved.snapshot.generation, value.generation); return new Promise(() => {});
    } }, fetchImpl: async () => { calls++; return response(value); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => read()));
  assert.equal(calls, 1); assert.equal(writes, 1);
  for (const result of results) { assert.equal(result.state.status, 'ready'); assert.equal(result.indexRecords.length, 1); assert.equal(result.state.retrievedAt, value.retrievedAt); }
  assert.equal((await read()).indexSource.generation, value.generation); assert.equal(calls, 1); assert.equal(writes, 1);
});

test('a late restored generation cannot overwrite a newer release acquired after the storage deadline', { timeout: 1000 }, async () => {
  let calls = 0; const delayedGet = Promise.withResolvers(), old = await snapshot(initial - EONET_REFRESH_MS);
  const fresh = await createEonetSnapshot({ events: [{ ...event, title: 'Newer synthetic reference' }] },
    { retrievedAt: new Date(initial).toISOString(), nowMs: initial });
  const read = createEonetSnapshotReader({ now: () => initial, storageTimeoutMs: 10,
    store: { get() { return delayedGet.promise; } }, fetchImpl: async () => { calls++; return response(fresh); } });
  assert.equal((await read()).indexSource.generation, fresh.generation);
  delayedGet.resolve({ acquiredAt: initial - EONET_REFRESH_MS, snapshot: old });
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await read();
  assert.equal(calls, 1); assert.equal(retained.indexSource.generation, fresh.generation);
  assert.equal(retained.records[0].title, fresh.records[0].title); assert.equal(retained.state.retrievedAt, fresh.retrievedAt);
});
