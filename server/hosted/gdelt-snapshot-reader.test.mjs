import test from 'node:test';
import assert from 'node:assert/strict';
import { createGdeltSnapshotReader, validateGdeltSnapshot, GDELT_SNAPSHOT_URL, GDELT_SNAPSHOT_MAX_BYTES, GDELT_RELEASE_CHECK_INTERVAL_MS } from './gdelt-snapshot.js';
import { gdeltQueryUrl } from './gdelt-query.js';
import { normalizeGdelt } from './intelligence-sources.js';
import { intelligenceProxy } from './intelligence.js';

const CLOCK = Date.parse('2026-10-11T10:00:00Z');
const filters = (category = 'all', values = {}) => ({ category, country: '', countryName: '', q: '', ...values });
function fixture(clock = CLOCK) {
  const generatedAt = new Date(clock).toISOString();
  const titles = { geopolitics: 'Japan ceasefire negotiations resume', economy: 'Belgium port trade negotiations resume', disasters: 'Flood warnings in Belgium' };
  const categories = Object.fromEntries(Object.entries(titles).map(([category, title]) => [category, {
    queryUrl: gdeltQueryUrl({ category }), retrievedAt: generatedAt,
    reports: normalizeGdelt({ articles: [{ title, url: `https://publisher.example/${category}`, seendate: new Date(clock - 60000).toISOString(), sourcecountry: 'France', language: 'English' }] }, generatedAt, category),
  }]));
  return { schemaVersion: 1, generatedAt, source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: ['geopolitics', 'economy', 'disasters'] }, categories };
}
function endpoint(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(_path, callback) { handler = callback; } } });
  return async (url) => {
    let status, value;
    await handler({ method: 'GET', url }, { writeHead(code) { status = code; }, end(body) { value = JSON.parse(body); } });
    return { status, value };
  };
}

test('snapshot validator admits only fixed title/link discovery metadata and honest times', () => {
  const snapshot = fixture();
  const accepted = validateGdeltSnapshot(snapshot, CLOCK);
  assert.equal(accepted.categories.economy.reports[0].publishedAt, null);
  assert.match(accepted.coverage.note, /Original publishers retain their rights/);
  for (const mutate of [
    (value) => { value.source.url = 'https://unapproved.example/'; },
    (value) => { value.categories.economy.queryUrl += '&url=https://unapproved.example'; },
    (value) => { value.generatedAt = new Date(CLOCK + 600000).toISOString(); },
    (value) => { value.categories.economy.reports[0].lat = 50; },
    (value) => { value.categories.economy.reports[0].body = 'Publisher article content'; },
    (value) => { value.categories.economy.reports[0].url = 'javascript:alert(1)'; },
    (value) => { value.categories.economy.reports[0].publishedAt = value.generatedAt; },
    (value) => { value.categories.economy.reports[0].indexedAt = new Date(CLOCK + 600000).toISOString(); },
    (value) => { value.categories.economy.reports.push(value.categories.economy.reports[0]); },
    (value) => { value.categories.economy.reports = Array.from({ length: 81 }, () => value.categories.economy.reports[0]); },
  ]) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    assert.throws(() => validateGdeltSnapshot(invalid, CLOCK));
  }
  assert.throws(() => validateGdeltSnapshot(snapshot, CLOCK + 86400001), /expired/);
});

test('all visitor topics share one scheduled acquisition and country filters inspect titles without inventing locations', async () => {
  let requests = 0;
  const gate = Promise.withResolvers();
  const read = createGdeltSnapshotReader({ now: () => CLOCK, fetchImpl: async (url) => {
    requests++; assert.equal(url, GDELT_SNAPSHOT_URL); await gate.promise; return Response.json(fixture());
  } });
  assert.equal(requests, 0);
  const visitors = [read(filters()), read(filters('economy', { country: 'BE', countryName: 'Belgium' })), read(filters('geopolitics'))];
  gate.resolve(); const [all, belgium, geopolitics] = await Promise.all(visitors);
  assert.equal(requests, 1); assert.equal(all.records.length, 3); assert.equal(geopolitics.records.length, 1);
  assert.equal(belgium.records.length, 1); assert.equal(belgium.records[0].publisherCountry, 'France');
  assert.equal(belgium.records[0].lat, undefined); assert.equal(belgium.state.filtersAppliedLocally, true);
  assert.match(belgium.state.coverage, /empty result does not establish absence/);
  assert.deepEqual((await read(filters('economy', { q: 'unmatched topic' }))).records, []);
  assert.equal(requests, 1, 'custom filters never fan out to the live GDELT provider');
});

test('release rechecks after 60 seconds coalesce all filters and acquire a newly published generation', async () => {
  let clock = CLOCK, requests = 0;
  const gate = Promise.withResolvers();
  const read = createGdeltSnapshotReader({ now: () => clock, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, GDELT_SNAPSHOT_URL); assert.equal(options.headers['Cache-Control'], 'no-cache');
    if (requests === 1) return Response.json(fixture());
    await gate.promise; return Response.json(fixture(clock));
  } });
  const first = await read(filters());
  assert.equal(first.state.refreshIntervalMs, 60000); assert.equal(first.state.sourceCadenceMs, 900000);
  clock += GDELT_RELEASE_CHECK_INTERVAL_MS - 1;
  await read(filters('economy')); assert.equal(requests, 1);
  clock++;
  const visitors = [read(filters()), read(filters('economy')), read(filters('disasters', { country: 'BE', countryName: 'Belgium' }))];
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(requests, 2);
  gate.resolve();
  for (const value of await Promise.all(visitors)) {
    assert.equal(value.state.generatedAt, new Date(clock).toISOString());
    assert.equal(value.state.retrievedAt, new Date(clock).toISOString());
    assert.equal(value.indexSource.generation, new Date(clock).toISOString()); assert.equal(value.state.status, 'ready');
  }
  assert.equal(requests, 2);
});

test('conditional unchanged release checks retain source and download dates while respecting staleness and expiry', async () => {
  let clock = CLOCK, requests = 0, saved;
  const read = createGdeltSnapshotReader({ now: () => clock,
    store: { async get() { return null; }, async put(_key, value) { saved = structuredClone(value); } },
    fetchImpl: async (_url, options) => {
      requests++;
      if (requests === 1) return Response.json(fixture(), { headers: { etag: 'W/"fixed-generation"' } });
      assert.equal(options.headers['If-None-Match'], 'W/"fixed-generation"');
      return new Response(null, { status: 304 });
    } });
  const first = await read(filters());
  clock += GDELT_RELEASE_CHECK_INTERVAL_MS;
  const checked = await read(filters());
  assert.equal(requests, 2); assert.equal(checked.state.status, 'ready'); assert.equal(checked.state.ageMs, 60000);
  for (const field of ['generatedAt', 'retrievedAt', 'snapshotRetrievedAt']) assert.equal(checked.state[field], first.state[field]);
  assert.equal(checked.state.snapshotCheckedAt, new Date(clock).toISOString());
  assert.equal(saved.acquiredAt, CLOCK); assert.equal(saved.checkedAt, clock);
  assert.equal(saved.snapshot.generatedAt, first.state.generatedAt);
  await read(filters('economy')); assert.equal(requests, 2, 'successful checks reset only the 60-second delivery clock');
  const cold = createGdeltSnapshotReader({ now: () => clock + 1000,
    store: { async get() { return structuredClone(saved); } }, fetchImpl: async () => { throw new Error('Fresh check restored from storage'); } });
  const restored = await cold(filters()); assert.equal(restored.state.status, 'ready');
  assert.equal(restored.state.snapshotRetrievedAt, first.state.snapshotRetrievedAt);
  assert.equal(restored.state.snapshotCheckedAt, checked.state.snapshotCheckedAt);
  clock = CLOCK + 1800001;
  const old = await read(filters()); assert.equal(old.state.status, 'stale'); assert.equal(old.state.ageMs, 1800001);
  assert.equal(old.state.retrievedAt, first.state.retrievedAt); assert.equal(old.records[0].indexedAt, first.records[0].indexedAt);
  clock = CLOCK + 86400001;
  const expired = await read(filters()); assert.equal(expired.state.status, 'unavailable'); assert.deepEqual(expired.records, []);
  assert.match(expired.state.reason, /24-hour age limit/);
});

test('unexpected unchanged responses cannot create a snapshot and invalid entity tags are never reflected', async () => {
  const missing = createGdeltSnapshotReader({ now: () => CLOCK, fetchImpl: async () => new Response(null, { status: 304 }) });
  const unavailable = await missing(filters()); assert.equal(unavailable.state.status, 'unavailable');
  assert.deepEqual(unavailable.records, []); assert.ok(unavailable.state.retryAt > CLOCK);
  let clock = CLOCK, requests = 0;
  const read = createGdeltSnapshotReader({ now: () => clock, fetchImpl: async (_url, options) => {
    requests++; assert.equal(options.headers['If-None-Match'], undefined);
    return Response.json(fixture(), { headers: { etag: 'unquoted-entity-tag' } });
  } });
  await read(filters()); clock += GDELT_RELEASE_CHECK_INTERVAL_MS;
  const checked = await read(filters()); assert.equal(requests, 2); assert.equal(checked.state.generatedAt, new Date(CLOCK).toISOString());
  assert.equal(checked.state.ageMs, 60000, 'unchanged payload retrieval does not relabel source generation');
});

test('faster delivery checks do not shorten the legacy snapshot 30-minute retrieval validation window', () => {
  const value = fixture();
  for (const category of Object.values(value.categories)) {
    category.reports = []; category.retrievedAt = new Date(CLOCK - 1800000).toISOString();
  }
  assert.equal(validateGdeltSnapshot(value, CLOCK).generatedAt, value.generatedAt);
  value.categories.economy.retrievedAt = new Date(CLOCK - 1800001).toISOString();
  assert.throws(() => validateGdeltSnapshot(value, CLOCK), /retrieval window/);
});

test('independent readers with an atomic shared lease perform one release check and adopt its newer publication', async () => {
  let clock = CLOCK, requests = 0, until = 0;
  let saved = { acquiredAt: CLOCK - 60000, snapshot: fixture(CLOCK - 60000) };
  const gate = Promise.withResolvers();
  const store = {
    async get() { return structuredClone(saved); },
    async put(_key, value) { saved = structuredClone(value); },
    async claim(key, at, wait) {
      assert.equal(key, 'gdelt:release-check'); assert.equal(wait, 60000);
      if (until > at) return false;
      until = at + wait; return true;
    },
  };
  const fetchImpl = async () => { requests++; await gate.promise; return Response.json(fixture(clock)); };
  const one = createGdeltSnapshotReader({ now: () => clock, store, fetchImpl });
  const two = createGdeltSnapshotReader({ now: () => clock, store, fetchImpl });
  const active = one(filters());
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(requests, 1);
  const waiting = await two(filters('economy')); assert.equal(requests, 1);
  assert.equal(waiting.state.generatedAt, new Date(CLOCK - 60000).toISOString());
  assert.equal(waiting.state.retryAt, CLOCK + 1000);
  gate.resolve(); const published = await active;
  clock += 1000;
  const adopted = await two(filters('economy')); assert.equal(requests, 1);
  assert.equal(adopted.state.generatedAt, published.state.generatedAt);
  assert.equal(adopted.state.retrievedAt, published.state.retrievedAt);
  assert.equal(adopted.state.snapshotRetrievedAt, published.state.snapshotRetrievedAt);
  assert.equal(adopted.state.retryAt, null);
});

test('shared lease reload cannot replace a newer source generation with a recently checked older one', async () => {
  let clock = CLOCK, requests = 0, gets = 0;
  const read = createGdeltSnapshotReader({ now: () => clock,
    store: {
      async get() { gets++; return gets === 1 ? null : { acquiredAt: CLOCK, checkedAt: clock, snapshot: fixture(CLOCK - 1000) }; },
      async claim() { return requests === 0; },
    }, fetchImpl: async () => { requests++; return Response.json(fixture()); } });
  await read(filters()); clock += 60000;
  const retained = await read(filters());
  assert.equal(requests, 1); assert.equal(gets, 2);
  assert.equal(retained.state.generatedAt, new Date(CLOCK).toISOString());
  assert.equal(retained.state.snapshotCheckedAt, new Date(CLOCK).toISOString());
  assert.ok(retained.indexRecords.every((record) => record.retrievedAt === new Date(CLOCK).toISOString()));
});

test('unavailable or stalled optional shared leases fall back to one local coalesced release check', { timeout: 1000 }, async () => {
  for (const claim of [() => { throw new Error('Storage unavailable'); }, () => new Promise(() => {})]) {
    let requests = 0;
    const read = createGdeltSnapshotReader({ now: () => CLOCK, storageTimeoutMs: 10, store: { claim },
      fetchImpl: async () => { requests++; return Response.json(fixture()); } });
    const results = await Promise.all(Array.from({ length: 6 }, () => read(filters())));
    assert.equal(requests, 1); assert.ok(results.every((value) => value.state.status === 'ready'));
  }
});

test('release failure retains explicit stale records and original times, then withholds snapshots beyond 24 hours', async () => {
  let clock = CLOCK, fail = false, requests = 0;
  const read = createGdeltSnapshotReader({ now: () => clock, fetchImpl: async () => {
    requests++; return fail ? new Response('offline', { status: 503 }) : Response.json(fixture());
  } });
  const first = await read(filters('economy'));
  clock += 1800001; fail = true;
  const stale = await read(filters('economy'));
  assert.equal(stale.state.status, 'stale'); assert.equal(stale.state.ageMs, 1800001);
  assert.equal(stale.records[0].retrievedAt, first.records[0].retrievedAt);
  assert.match(stale.state.reason, /unavailable/); assert.ok(stale.state.retryAt > clock);
  await read(filters('geopolitics')); assert.equal(requests, 2, 'release failures share backoff across every topic');
  clock = CLOCK + 86400001;
  const expired = await read(filters());
  assert.equal(expired.state.status, 'unavailable'); assert.deepEqual(expired.records, []);
  assert.match(expired.state.reason, /24-hour age limit/);
});

test('oversized scheduled assets cancel the body and cannot replace a last-good snapshot', async () => {
  let clock = CLOCK, cancelled = false;
  const read = createGdeltSnapshotReader({ now: () => clock, fetchImpl: async () => clock === CLOCK ? Response.json(fixture()) :
    new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(GDELT_SNAPSHOT_MAX_BYTES + 1) } }) });
  await read(filters()); clock += 1800001;
  const stale = await read(filters());
  assert.equal(cancelled, true); assert.equal(stale.state.status, 'stale'); assert.equal(stale.records.length, 3);
});

test('cold readers coalesce persisted restore and cache failures never reject successful scheduled data', async () => {
  let saved, calls = 0, gets = 0;
  const store = { async get() { gets++; return structuredClone(saved); }, async put(_key, value) { saved = structuredClone(value); } };
  const warm = createGdeltSnapshotReader({ now: () => CLOCK, store, fetchImpl: async () => { calls++; return Response.json(fixture()); } });
  await warm(filters());
  const gate = Promise.withResolvers();
  const cold = createGdeltSnapshotReader({ now: () => CLOCK + 1000, store: { ...store, async get() { gets++; await gate.promise; return structuredClone(saved); } },
    fetchImpl: async () => { calls++; throw new Error('Must use fresh persisted snapshot'); } });
  const visitors = [cold(filters()), cold(filters('economy'))]; gate.resolve();
  assert.ok((await Promise.all(visitors)).every((value) => value.state.status === 'ready'));
  assert.equal(calls, 1); assert.equal(gets, 2);
  const broken = createGdeltSnapshotReader({ now: () => CLOCK, store: { get() { throw new Error('Unavailable'); }, put() { throw new Error('Full'); } },
    fetchImpl: async () => Response.json(fixture()) });
  assert.equal((await broken(filters())).state.status, 'ready');
});

test('never-settling optional storage reads cannot prevent shared release recovery', { timeout: 1000 }, async () => {
  let gets = 0, requests = 0;
  const read = createGdeltSnapshotReader({ now: () => CLOCK, storageTimeoutMs: 10,
    store: { get() { gets++; return new Promise(() => {}); } },
    fetchImpl: async (url) => { requests++; assert.equal(url, GDELT_SNAPSHOT_URL); return Response.json(fixture()); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => read(filters())));
  assert.equal(gets, 1); assert.equal(requests, 1);
  for (const result of results) {
    assert.equal(result.state.status, 'ready'); assert.equal(result.indexSource.generation, new Date(CLOCK).toISOString());
    assert.equal(result.indexRecords.length, 3);
  }
  await read(filters('economy')); assert.equal(gets, 1); assert.equal(requests, 1);
});

test('never-settling optional storage writes release coalesced callers with unchanged source dates', { timeout: 1000 }, async () => {
  let writes = 0, requests = 0;
  const read = createGdeltSnapshotReader({ now: () => CLOCK, storageTimeoutMs: 10,
    store: { async get() { return null; }, put(key, value) {
      writes++; assert.equal(key, 'gdelt:snapshot'); assert.equal(value.snapshot.generatedAt, new Date(CLOCK).toISOString());
      return new Promise(() => {});
    } }, fetchImpl: async () => { requests++; return Response.json(fixture()); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => read(filters())));
  assert.equal(writes, 1); assert.equal(requests, 1);
  for (const result of results) {
    assert.equal(result.state.status, 'ready'); assert.equal(result.records.length, 3);
    assert.equal(result.state.generatedAt, new Date(CLOCK).toISOString()); assert.equal(result.state.retrievedAt, new Date(CLOCK).toISOString());
  }
  assert.equal((await read(filters())).indexSource.generation, new Date(CLOCK).toISOString());
  assert.equal(writes, 1); assert.equal(requests, 1);
});

test('late restored metadata cannot overwrite a newer generation acquired after the storage deadline', { timeout: 1000 }, async () => {
  let requests = 0; const delayedGet = Promise.withResolvers(), old = fixture(CLOCK - 1800000), fresh = fixture();
  const read = createGdeltSnapshotReader({ now: () => CLOCK, storageTimeoutMs: 10,
    store: { get() { return delayedGet.promise; } }, fetchImpl: async () => { requests++; return Response.json(fresh); } });
  assert.equal((await read(filters())).indexSource.generation, fresh.generatedAt);
  delayedGet.resolve({ acquiredAt: CLOCK - 1800000, snapshot: old });
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await read(filters());
  assert.equal(requests, 1); assert.equal(retained.indexSource.generation, fresh.generatedAt);
  assert.equal(retained.state.generatedAt, fresh.generatedAt); assert.equal(retained.state.retrievedAt, fresh.generatedAt);
  assert.ok(retained.indexRecords.every((record) => record.retrievedAt === fresh.generatedAt));
});

test('public intelligence uses schedule-only by default while unavailable snapshots permit explicitly controlled live fallback', async () => {
  const urls = [];
  const scheduled = endpoint(intelligenceProxy({ now: () => CLOCK, env: {}, fetchImpl: async (url) => { urls.push(url); return Response.json(fixture()); } }));
  assert.equal((await scheduled('/?category=geopolitics')).value.sources[0].mode, 'scheduled-snapshot');
  await scheduled('/?category=economy&country=BE&q=trade'); assert.deepEqual(urls, [GDELT_SNAPSHOT_URL]);
  const unavailable = endpoint(intelligenceProxy({ now: () => CLOCK, env: {}, fetchImpl: async (url) => { urls.push(url); return new Response('', { status: 503 }); } }));
  const missing = await unavailable('/?category=geopolitics');
  assert.equal(missing.value.sources[0].status, 'unavailable'); assert.deepEqual(missing.value.reports, []);
  assert.equal(urls.some((url) => url.startsWith('https://api.gdeltproject.org/')), false);
  let liveRequests = 0;
  const fallback = endpoint(intelligenceProxy({ now: () => CLOCK, env: { GDELT_LIVE_FALLBACK: '1' }, fetchImpl: async (url) => {
    if (url === GDELT_SNAPSHOT_URL) return new Response('', { status: 503 });
    liveRequests++; return Response.json({ articles: [{ title: 'Diplomatic negotiations resume', url: 'https://publisher.example/live', seendate: '20261011T093000Z' }] });
  } }));
  const live = await fallback('/?category=geopolitics');
  assert.equal(live.value.sources[0].mode, 'live-fallback'); assert.equal(live.value.sources[0].status, 'ready');
  await fallback('/?category=economy&q=shipping'); assert.equal(liveRequests, 1, 'live fallback preserves provider-wide request spacing');
});
