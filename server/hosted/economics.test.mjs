import test from 'node:test';
import assert from 'node:assert/strict';
import { economicsProxy, economicsQuery, economicsQueryUrl, normalizeEconomics } from './economics.js';
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
