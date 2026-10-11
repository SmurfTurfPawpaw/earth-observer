import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceProxy as createIntelligenceProxy, intelligenceQuery, gdeltQueryUrl } from './intelligence.js';
import { normalizeGdelt, normalizeUsgs, normalizeGdacs, groupReports, safeReportUrl } from './intelligence-sources.js';

// Exercise the explicitly controlled live fallback independently of scheduled assets.
const intelligenceProxy = (options) => createIntelligenceProxy({ snapshotReader: null, allowLiveGdeltFallback: true, ...options });

const timestamp = Date.UTC(2026, 9, 11, 10);
const gdelt = { articles: [{ title: 'Port trade negotiations resume after delays', url: 'https://publisher.example/news/one?utm_source=feed', seendate: '20261011T093000Z', sourcecountry: 'France', language: 'English' }] };
const usgs = { features: [{ id: 'us-test', geometry: { type: 'Point', coordinates: [4, 50, 10] }, properties: { title: 'M 4.8 earthquake near a mapped location', time: timestamp - 10000, updated: timestamp, status: 'reviewed', mag: 4.8, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us-test' } }] };
const gdacs = { features: [{ geometry: { type: 'Point', coordinates: [4.05, 50.05] }, properties: { eventid: 123, eventtype: 'EQ', episodeid: 1, name: 'Earthquake in Belgium', country: 'Belgium', affectedcountries: [{ iso2: 'BE' }], fromdate: '2026-10-11T10:00:00', datemodified: '2026-10-11T10:01:00', alertlevel: 'Green', source: 'USGS', url: { report: 'https://www.gdacs.org/report.aspx?eventid=123&eventtype=EQ' } } }] };
const response = (url) => Response.json(url.includes('gdeltproject') ? gdelt : url.includes('usgs.gov') ? usgs : gdacs);
function endpoint(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(path, callback) { assert.equal(path, '/api/intelligence'); handler = callback; } } });
  return async (url = '/?category=all', method = 'GET') => {
    let status, headers, body;
    await handler({ url, method }, { writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } });
    return { status, headers, payload: body ? JSON.parse(body) : null };
  };
}

test('bounded filters reject arbitrary operators, URLs, duplicates and unknown categories before upstream work', async () => {
  let requests = 0;
  const read = endpoint(intelligenceProxy({ fetchImpl: () => { requests++; throw new Error('Unexpected network'); } }));
  for (const query of ['category=nope', 'q=domain%3Aevil.test', 'q=%22injected%22', 'q=---', `q=${'x'.repeat(65)}`, 'country=INVALID', 'country=ZZ', 'q=trade&q=war', 'url=https://evil.test']) {
    assert.equal((await read(`/?${query}`)).status, 400, query);
  }
  assert.equal((await read('/', 'POST')).status, 405);
  assert.equal((await read('/other')).status, 404);
  assert.equal(requests, 0);
  const filters = intelligenceQuery(new URLSearchParams('category=economy&country=BE&q=port%20trade'));
  const url = new URL(gdeltQueryUrl(filters));
  assert.equal(url.hostname, 'api.gdeltproject.org');
  assert.match(url.searchParams.get('query'), /"Belgium"/);
  assert.equal(url.searchParams.get('maxrecords'), '80');
  assert.equal(url.searchParams.get('timespan'), '24h');
});

test('initialization does no work, identical visitors share requests, and fresh cache prevents provider fan-out', async () => {
  let requests = 0;
  const gate = Promise.withResolvers();
  const plugin = intelligenceProxy({ now: () => timestamp, fetchImpl: async (url) => { requests++; await gate.promise; return response(url); } });
  assert.equal(requests, 0);
  const read = endpoint(plugin);
  const visitors = Array.from({ length: 8 }, () => read());
  gate.resolve();
  const results = await Promise.all(visitors);
  assert.equal(requests, 3);
  assert.ok(results.every((result) => result.status === 200 && result.payload.sources.every((source) => source.status === 'ready')));
  assert.match(results[0].payload.grouping, /do not establish independent confirmation/);
  assert.equal((await read()).status, 200);
  assert.equal(requests, 3);
});

test('provider failure serves explicit stale results with backoff shared across new topic keys', async () => {
  let clock = timestamp, fail = false, requests = 0;
  const read = endpoint(intelligenceProxy({ now: () => clock, fetchImpl: async (url) => { requests++; return fail ? new Response('', { status: 429 }) : response(url); } }));
  const first = await read('/?category=economy');
  assert.equal(first.payload.sources[0].status, 'ready');
  clock += 301000; fail = true;
  const stale = await read('/?category=economy');
  assert.equal(stale.payload.sources[0].status, 'stale');
  assert.equal(stale.payload.sources[0].stale, true);
  assert.match(stale.payload.sources[0].reason, /HTTP 429/);
  assert.equal(stale.payload.reports[0].retrievedAt, first.payload.reports[0].retrievedAt);
  assert.equal(stale.payload.sources[0].ageMs, 301000);
  await read('/?category=economy');
  const different = await read('/?category=economy&q=shipping');
  assert.equal(different.payload.sources[0].status, 'unavailable');
  assert.ok(different.payload.sources[0].retryAt > clock);
  assert.equal(requests, 2);
});

test('longer upstream Retry-After is honored and news older than the stale limit is withheld', async () => {
  let clock = timestamp, requests = 0;
  const read = endpoint(intelligenceProxy({ now: () => clock, fetchImpl: async () => {
    requests++;
    return requests === 1 ? Response.json(gdelt) : new Response('', { status: 429, headers: { 'Retry-After': '7200' } });
  } }));
  await read('/?category=economy'); clock += 301000;
  const stale = await read('/?category=economy');
  assert.equal(stale.payload.sources[0].retryAt, clock + 7200000);
  clock += 3600000; await read('/?category=economy&q=ports'); assert.equal(requests, 2);
  clock += 86400001;
  const expired = await read('/?category=economy');
  assert.equal(expired.payload.sources[0].status, 'unavailable');
  assert.deepEqual(expired.payload.reports, []);
  assert.match(expired.payload.sources[0].reason, /staleness limit/);
});

test('different news searches respect provider spacing, category selects only applicable feeds, and country has explicit semantics', async () => {
  let clock = timestamp, requests = [];
  const read = endpoint(intelligenceProxy({ now: () => clock, fetchImpl: async (url) => { requests.push(url); return response(url); } }));
  await read('/?category=geopolitics'); assert.equal(requests.length, 1);
  const busy = await read('/?category=economy'); assert.equal(requests.length, 1);
  assert.equal(busy.payload.sources[0].status, 'busy');
  clock += 6001;
  const country = await read('/?category=disasters&country=BE');
  assert.equal(requests.length, 3);
  assert.equal(country.payload.sources.find((source) => source.id === 'usgs').status, 'not-applicable');
  assert.ok(country.payload.reports.some((report) => report.sourceId === 'gdacs'));
  assert.match(country.payload.coverage, /not geographic proof/);
});

test('news times remain indexing times, unsafe links are rejected, and related coverage retains each source independently', () => {
  const stamp = new Date(timestamp).toISOString();
  const news = normalizeGdelt(gdelt, stamp, 'economy')[0];
  assert.equal(news.publishedAt, null);
  assert.equal(news.indexedAt, '2026-10-11T09:30:00.000Z');
  assert.equal(news.publisherCountry, 'France');
  assert.equal(news.url, 'https://publisher.example/news/one');
  assert.equal(safeReportUrl('javascript:alert(1)'), null);
  assert.equal(safeReportUrl('https://user:password@example.test/'), null);
  const hazards = groupReports([...normalizeUsgs(usgs, stamp), ...normalizeGdacs(gdacs, stamp)]);
  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].relatedReports.length, 1);
  assert.notEqual(hazards[0].url, hazards[0].relatedReports[0].url);
  assert.match(hazards[0].relatedReports[0].relatedReason, /same measurements/);
  assert.equal(hazards[0].confirmed, undefined);
  const other = { ...news, url: 'https://different.example/news/two', source: 'different.example', title: news.title };
  const grouped = groupReports([news, other]);
  assert.equal(grouped[0].relatedReports.length, 1);
  assert.match(grouped[0].relatedReports[0].relatedReason, /syndicated/);
});

test('oversized or malformed upstream data never produces manufactured reports', async () => {
  const read = endpoint(intelligenceProxy({ now: () => timestamp, fetchImpl: async () => new Response('x', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }) }));
  const result = await read('/?category=economy');
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.reports, []);
  assert.equal(result.payload.sources[0].status, 'unavailable');
});

test('a dense provider sequence keeps a bounded sample of older sources in chronological order', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ sourceId: 'usgs', source: 'USGS', category: 'disasters', title: `Quake ${index}`, url: `https://example.test/usgs/${index}`, observedAt: new Date(timestamp - index * 1000).toISOString() }));
  rows.push(...Array.from({ length: 20 }, (_, index) => ({ sourceId: 'gdacs', source: 'GDACS', category: 'disasters', title: `Flood ${index}`, url: `https://example.test/gdacs/${index}`, observedAt: new Date(timestamp - 1000000 - index * 1000).toISOString() })));
  const selected = groupReports(rows);
  assert.equal(selected.length, 80); assert.equal(selected.filter((row) => row.sourceId === 'gdacs').length, 10);
  assert.equal(new Set(selected.map((row) => row.url)).size, 80);
  assert.deepEqual(selected.map((row) => row.observedAt), selected.map((row) => row.observedAt).sort().reverse());
});
