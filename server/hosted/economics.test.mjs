import test from 'node:test';
import assert from 'node:assert/strict';
import { economicsProxy, economicsQuery, economicsQueryUrl, normalizeEconomics, validateEconomicsSnapshot } from './economics.js';
import { ECONOMICS_INDICATORS, ECONOMICS_COUNTRIES, economicsCountry } from '../../src/core/economics-catalog.js';

const AT = Date.parse('2026-10-11T00:00:00Z'), DAY = 86400000;
// Synthetic observations exercise the protocol; these are not actual national statistics.
function fixture(country = 'BEL') {
  const rows = ECONOMICS_INDICATORS.map((item, index) => ({ indicator: { id: item.id }, countryiso3code: country,
    date: '2024', value: index + 1, footnote: '' }));
  rows.push({ indicator: { id: 'FP.CPI.TOTL.ZG' }, countryiso3code: country, date: '2025', value: null });
  rows.push({ indicator: { id: 'NE.TRD.GNFS.ZS' }, countryiso3code: country, date: '2025', value: 0, footnote: 'Provisional\n estimate' });
  return [{ page: 1, pages: 1, total: rows.length, sourceid: '2', lastupdated: '2026-10-07' }, rows];
}
const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const storeFixture = (country = 'BEL', retrievedAt = new Date(AT).toISOString()) => ({ schemaVersion: 1, country, retrievedAt,
  datasetUpdatedDate: '2026-10-07', observations: [{ indicator: 'NY.GDP.MKTP.CD', year: 2025, value: 123 }] });

test('annual snapshots restore across cold providers without unrelated country reads or source requests', async () => {
  const records = new Map(), reads = []; let calls = 0, at = AT;
  const snapshotStore = { async get(key) { reads.push(key); return records.get(key); },
    async put(key, value) { records.set(key, structuredClone(value)); } };
  const options = { now: () => at, snapshotStore, fetchImpl: async () => { calls++; return json(fixture()); } };
  const first = economicsProxy(options);
  assert.equal(reads.length, 0, 'constructor does no storage or network I/O');
  const original = await first.getSnapshot('BE');
  assert.equal(calls, 1); assert.equal(records.size, 1); assert.equal(records.has('economics:annual:BEL'), true);
  assert.equal(records.get('economics:annual:BEL').observations.length, 7);
  at += 3600000;
  const cold = economicsProxy(options);
  const restored = await cold.getSnapshot('BEL');
  assert.equal(calls, 1); assert.equal(restored.status, 'ready');
  assert.equal(restored.retrievedAt, original.retrievedAt); assert.equal(restored.source.ageMs, 3600000);
  assert.equal(restored.source.ageCalculatedAt, new Date(at).toISOString());
  assert.deepEqual(restored.indicators, original.indicators);
  assert.ok(reads.every((key) => key === 'economics:annual:BEL'));
});

test('concurrent aliases share one lazy persistent restore, then retain stale observations through a failed refresh', async () => {
  let at = AT + DAY, reads = 0, calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = economicsProxy({ now: () => at, onProviderError: null, snapshotStore: {
    async get() { reads++; await gate; return storeFixture(); },
  }, fetchImpl: async () => { calls++; throw new TypeError('Upstream unavailable'); } });
  const first = provider.getSnapshot('BE'), alias = provider.getSnapshot('BEL');
  release(); const results = await Promise.all([first, alias]);
  assert.equal(reads, 1); assert.equal(calls, 1);
  assert.ok(results.every((item) => item.status === 'stale' && item.indicators[0].value === 123 && item.source.ageMs === DAY));
  assert.equal(results[0].retrievedAt, new Date(AT).toISOString());
  await provider.getSnapshot('BE'); assert.equal(reads, 1); assert.equal(calls, 1, 'cooldown suppresses repeated reads and upstream work');
  at = AT + 8 * DAY;
  assert.equal((await provider.getSnapshot('BE')).status, 'unavailable');
});

test('stored annual records reject foreign countries, injected metadata, invalid dates and oversized histories', async () => {
  const mutations = [
    (saved) => { saved.schemaVersion = 2; }, (saved) => { saved.country = 'USA'; },
    (saved) => { saved.source = { license: 'Unreviewed' }; },
    (saved) => { saved.retrievedAt = new Date(AT + 1).toISOString(); },
    (saved) => { saved.retrievedAt = new Date(AT - 8 * DAY).toISOString(); },
    (saved) => { saved.retrievedAt = '2026-10-11'; },
    (saved) => { saved.datasetUpdatedDate = '2026-02-30'; },
    (saved) => { saved.datasetUpdatedDate = '2026-12-31'; },
    (saved) => { saved.observations[0].indicator = 'UNREVIEWED'; },
    (saved) => { saved.observations[0].url = 'https://unreviewed.example'; },
    (saved) => { saved.observations[0].value = '123'; },
    (saved) => { saved.observations[0].year = 2026; },
    (saved) => { saved.observations[0].footnote = 'Bad\n footnote'; },
    (saved) => { saved.observations[0].footnote = 'a'.repeat(601); },
    (saved) => { saved.observations.push({ ...saved.observations[0] }); },
    (saved) => { saved.observations = Array.from({ length: 51 }, () => ({ ...saved.observations[0] })); },
  ];
  for (const mutate of mutations) {
    const saved = storeFixture(); mutate(saved);
    assert.throws(() => validateEconomicsSnapshot(saved, 'BE', AT));
    let calls = 0;
    const provider = economicsProxy({ now: () => AT, snapshotStore: { get: async () => saved },
      fetchImpl: async () => { calls++; return json(fixture()); } });
    assert.equal((await provider.getSnapshot('BE')).status, 'ready'); assert.equal(calls, 1, 'invalid storage recovers from fixed source');
  }
});

test('persistent December annual windows remain valid in January without inventing a new observation year', () => {
  const acquired = Date.parse('2026-12-30T00:00:00Z');
  const saved = storeFixture('BEL', new Date(acquired).toISOString());
  saved.observations[0].year = 2016;
  const entry = validateEconomicsSnapshot(saved, 'BE', Date.parse('2027-01-02T00:00:00Z'));
  assert.equal(entry.at, acquired); assert.equal(entry.data.indicators[0].year, 2016);
  assert.equal(entry.data.retrievedAt, saved.retrievedAt);
});

test('storage rejection and bounded read/write timeout cannot convert good network data to a feed failure', async () => {
  for (const snapshotStore of [
    { get() { throw new Error('R2 read unavailable'); }, put() { throw new Error('R2 write unavailable'); } },
    { get: () => new Promise(() => {}), put: () => new Promise(() => {}) },
  ]) {
    let calls = 0;
    const provider = economicsProxy({ now: () => AT, snapshotStore, storageTimeoutMs: 5,
      fetchImpl: async () => { calls++; return json(fixture()); } });
    assert.equal((await provider.getSnapshot('BE')).status, 'ready');
    assert.equal((await provider.getSnapshot('BEL')).status, 'ready'); assert.equal(calls, 1);
  }
});

test('a recent persistent snapshot is restored even during another country provider cooldown', async () => {
  let calls = 0;
  const provider = economicsProxy({ now: () => AT, onProviderError: null,
    snapshotStore: { get: async (key) => key.endsWith(':BEL') ? storeFixture() : null },
    fetchImpl: async () => { calls++; throw new Error('Upstream unavailable'); } });
  assert.equal((await provider.getSnapshot('US')).status, 'unavailable');
  const restored = await provider.getSnapshot('BE');
  assert.equal(restored.status, 'ready'); assert.equal(restored.indicators[0].value, 123); assert.equal(calls, 1);
});

test('HTTP economics caching cannot extend ready status beyond the remaining daily retrieval TTL', async () => {
  for (const [age, expected] of [[3600000, 'public, max-age=3600'], [DAY - 300000, 'public, max-age=300'], [DAY - 500, 'no-store']]) {
    const at = AT + age;
    const provider = economicsProxy({ now: () => at, snapshotStore: { get: async () => storeFixture() },
      fetchImpl: async () => { throw new Error('Should reuse saved data'); } });
    let handler;
    provider.configureServer({ middlewares: { use(_path, value) { handler = value; } } });
    let headers, payload;
    await handler({ method: 'GET', url: '/?country=BE' }, {
      writeHead(_status, value) { headers = value; }, end(value) { payload = JSON.parse(value); },
    });
    assert.equal(payload.status, 'ready'); assert.equal(headers['Cache-Control'], expected);
    assert.equal(headers['X-Feed-Age-Ms'], String(age));
  }
});

test('economic diagnostics distinguish request, body and validation failure without logging private exception data', async () => {
  for (const [fetchImpl, expectedStage, expectedKind] of [
    [async () => { throw new TypeError('Illegal invocation secret-token caller-address'); }, 'request', 'runtime-invocation'],
    [async () => new Response('private publisher response', { headers: { 'Content-Type': 'text/html' } }), 'read', 'invalid-json'],
    [async () => json([{ page: 1, pages: 2, sourceid: '2', total: 0 }, []]), 'validate', 'invalid-observations'],
  ]) {
    const diagnostics = [];
    const proxy = economicsProxy({ now: () => AT, fetchImpl, onProviderError: (value) => diagnostics.push(value) });
    assert.equal((await proxy.getSnapshot('BE')).status, 'unavailable');
    await proxy.getSnapshot('BE');
    assert.equal(diagnostics.length, 1, 'backoff suppresses repeated provider and diagnostic work');
    assert.equal(diagnostics[0].stage, expectedStage); assert.equal(diagnostics[0].kind, expectedKind);
    assert.equal(/secret-token|caller-address|private publisher|https:/.test(JSON.stringify(diagnostics)), false);
  }
});

test('economic country registry accepts verified economy aliases and rejects aggregates and arbitrary filters', () => {
  assert.equal(ECONOMICS_COUNTRIES.length, 218);
  assert.equal(economicsCountry(' be ').id, 'BEL');
  assert.equal(economicsCountry('BEL').iso2, 'BE');
  assert.equal(economicsCountry().id, 'WLD');
  for (const value of ['all', 'EU', 'LDC', 'ZZ', '../BEL', 'https://example.com']) assert.throws(() => economicsCountry(value));
  assert.equal(economicsQuery(new URLSearchParams('country=BE')).id, 'BEL');
  assert.throws(() => economicsQuery(new URLSearchParams('country=BE&country=US')));
  assert.throws(() => economicsQuery(new URLSearchParams('country=BE&url=https://example.com')));
  const url = new URL(economicsQueryUrl('BE', AT));
  assert.equal(url.origin, 'https://api.worldbank.org');
  assert.equal(url.searchParams.get('source'), '2');
  assert.equal(url.searchParams.get('date'), '2016:2025');
  assert.equal(url.pathname.split('/').at(-1).split(';').length, 5);
});

test('annual normalization retains zeroes, missing years, differing reference years and vetted credits', () => {
  const data = normalizeEconomics(fixture(), economicsCountry('BE'), new Date(AT).toISOString(), AT);
  const inflation = data.indicators.find((item) => item.id === 'FP.CPI.TOTL.ZG');
  const trade = data.indicators.find((item) => item.id === 'NE.TRD.GNFS.ZS');
  assert.equal(data.frequency, 'annual');
  assert.equal(data.datasetUpdatedDate, '2026-10-07');
  assert.equal(inflation.year, 2024);
  assert.equal(inflation.history[0].value, null);
  assert.equal(trade.value, 0);
  assert.equal(trade.year, 2025);
  assert.equal(trade.footnote, 'Provisional  estimate');
  assert.equal(trade.sourceUrl, 'https://data.worldbank.org/indicator/NE.TRD.GNFS.ZS?locations=BE');
  assert.equal(trade.license, 'CC BY 4.0');
  assert.equal(trade.sourceId, '2');
  assert.match(inflation.attribution, /International Monetary Fund/);
  assert.equal(data.indicators.every((item) => item.history.length <= 10), true);
  const composite = fixture(); composite[0].sourceid = null;
  assert.equal(normalizeEconomics(composite, economicsCountry('BE'), new Date(AT).toISOString(), AT).status, 'ready');
  const empty = [{ page: 1, pages: 1, total: 0, sourceid: '2' }, []];
  assert.equal(normalizeEconomics(empty, economicsCountry(), new Date(AT).toISOString(), AT).indicators.every((item) => item.value === null && item.year === null), true);
});

test('economic normalization rejects wrong dataset, pagination, foreign country, duplicated year and nonannual data', () => {
  const invalid = [
    (body) => { body[0].sourceid = '1'; },
    (body) => { body[0].pages = 2; },
    (body) => { body[1][0].countryiso3code = 'USA'; },
    (body) => { body[1][0].date = '2026'; },
    (body) => { body[1][0].date = '2024-01-01'; },
    (body) => { body[1][0].value = '123'; },
    (body) => { body[1][0].indicator.id = 'UNREVIEWED'; },
    (body) => { body[1].push({ ...body[1][0] }); body[0].total++; },
  ];
  for (const mutate of invalid) {
    const body = fixture(); mutate(body);
    assert.throws(() => normalizeEconomics(body, economicsCountry('BE'), new Date(AT).toISOString(), AT));
  }
});

test('economic proxy is lazy and coalesces canonical country aliases with bounded annual caching', async () => {
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = economicsProxy({ now: () => AT, fetchImpl: async (url, options) => {
    calls++; assert.match(url, /\/country\/BEL\/indicator\//); assert.equal(options.redirect, 'error');
    await gate; return json(fixture());
  } });
  assert.equal(calls, 0);
  const first = provider.getSnapshot('BE'), second = provider.getSnapshot('BEL');
  release(); const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results.every((value) => value.status === 'ready' && value.country.id === 'BEL'), true);
  await provider.getSnapshot('BE'); assert.equal(calls, 1);
});

test('failed economic refresh uses dated same-country cache and provider cooldown, then expires honestly', async () => {
  let at = AT, calls = 0;
  const provider = economicsProxy({ now: () => at, fetchImpl: async () => {
    calls++; return calls === 1 ? json(fixture()) : new Response('busy', { status: 429, headers: { 'Retry-After': '600' } });
  } });
  const first = await provider.getSnapshot('BE'); at += DAY;
  const stale = await provider.getSnapshot('BE');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.retrievedAt, first.retrievedAt);
  assert.equal(stale.source.ageMs, DAY);
  assert.equal(stale.source.retryAt, at + 600000);
  const missing = await provider.getSnapshot('US');
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.indicators.length, 0); assert.equal(calls, 2);
  at = AT + 8 * DAY;
  const expired = await provider.getSnapshot('BE');
  assert.equal(expired.status, 'unavailable'); assert.equal(expired.indicators.length, 0);
  assert.match(expired.reason, /seven-day/);
});

test('economic body cap and malformed responses do not manufacture available facts', async () => {
  for (const response of [new Response(' '.repeat(256 * 1024 + 1)), json({ unexpected: true }), new Response(null, { status: 302 })]) {
    const provider = economicsProxy({ now: () => AT, fetchImpl: async () => response });
    const data = await provider.getSnapshot('BE');
    assert.equal(data.status, 'unavailable'); assert.equal(data.indicators.length, 0);
    assert.ok(data.source.retryAt > AT);
  }
});

test('economic LRU and pending-country bounds cap resources without cross-country leakage', async () => {
  let calls = 0;
  const provider = economicsProxy({ maxKeys: 2, now: () => AT, fetchImpl: async (url) => {
    calls++; return json(fixture(new URL(url).pathname.split('/')[3]));
  } });
  await provider.getSnapshot('BE'); await provider.getSnapshot('US'); await provider.getSnapshot('GB');
  await provider.getSnapshot('US'); assert.equal(calls, 3);
  await provider.getSnapshot('BE'); assert.equal(calls, 4);
  let release;
  const busy = economicsProxy({ maxPending: 1, now: () => AT, fetchImpl: () => new Promise((resolve) => { release = () => resolve(json(fixture())); }) });
  const pending = busy.getSnapshot('BE');
  const second = await busy.getSnapshot('US'); assert.equal(second.status, 'unavailable'); assert.match(second.reason, /busy/);
  release(); await pending;
});
