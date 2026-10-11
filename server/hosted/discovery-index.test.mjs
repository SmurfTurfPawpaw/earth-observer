import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceProxy } from './intelligence.js';
import { createGkgSnapshot, gkgTopicReport } from './gdelt-gkg.js';
import { GDELT_SNAPSHOT_URL, validateGdeltSnapshot } from './gdelt-snapshot.js';
import { gdeltQueryUrl } from './gdelt-query.js';
import { createDiscoveryIndex } from '../../src/core/discovery-index.js';
import { createEonetSnapshot, EONET_SNAPSHOT_URL, EONET_QUERY_URL } from './eonet-snapshot.js';

const NOW = Date.parse('2026-10-11T10:05:00.000Z'), ISO = new Date(NOW).toISOString(), BATCH = '20261011100000';
function snapshot() {
  const reports = ['geopolitics', 'economy'].map((category) => gkgTopicReport({ url: 'https://bbc.example/report',
    themes: ['ARMEDCONFLICT', 'ELECTION', 'MILITARY', 'SANCTIONS', 'WB_698_TRADE'], mentionedCountries: ['UA'], category, batch: BATCH, retrievedAt: ISO }));
  reports.push(gkgTopicReport({ url: 'https://french.example/other', themes: ['NEGOTIATIONS'], mentionedCountries: ['FR'], category: 'geopolitics', batch: BATCH, retrievedAt: ISO }));
  return createGkgSnapshot({ reports, processedBatches: [{ id: BATCH, retrievedAt: ISO, rows: 2, matchedRecords: 3 }], generatedAt: ISO });
}
function endpoint(plugin) {
  let handler; plugin.configureServer({ middlewares: { use(_path, callback) { handler = callback; } } });
  return async (url) => { let code, body; await handler({ method: 'GET', url }, { writeHead(value) { code = value; }, end(value) { body = value; } }); return { code, payload: JSON.parse(body) }; };
}

test('country-name/topic/publisher searches share one snapshot and expose unfiltered local metadata with exact reasons', async () => {
  const urls = []; const read = endpoint(intelligenceProxy({ now: () => NOW, fetchImpl: async (url) => { urls.push(url); return Response.json(snapshot()); } }));
  const first = await read('/?category=geopolitics&country=UA&q=Ukraine%20sanctions');
  assert.equal(first.code, 200); assert.equal(first.payload.reports.length, 1);
  assert.match(first.payload.reports[0].matchReasons.join('\n'), /Country mentioned “Ukraine \(UA\)”/);
  assert.match(first.payload.reports[0].matchReasons.join('\n'), /Reviewed topic “Sanctions”/);
  assert.doesNotMatch(first.payload.reports[0].title, /Sanctions/);
  assert.equal(first.payload.indexRecords.length, 2, 'other countries and categories remain available for local queries');
  assert.ok(first.payload.indexRecords.some((record) => record.mentionedCountries.includes('FR')));
  assert.ok(first.payload.indexRecords.find((record) => record.url.includes('bbc')).reviewedTopics.includes('Trade'));
  assert.equal(first.payload.indexCoverage.schemaVersion, 1); assert.equal(first.payload.indexCoverage.maxRecords, 500);
  const version = first.payload.indexVersion;
  const economy = await read('/?category=economy&q=Ukraine%20trade'); assert.equal(economy.payload.reports.length, 1);
  const publisher = await read('/?category=geopolitics&q=bbc.example'); assert.equal(publisher.payload.reports.length, 1);
  assert.equal(publisher.payload.indexVersion, version); assert.deepEqual(urls, [GDELT_SNAPSHOT_URL]);
  const local = createDiscoveryIndex({ now: () => NOW }); local.replacePayload(first.payload);
  assert.equal(local.search({ q: 'France negotiations' }).reports.length, 1);
  assert.equal(local.search({ q: 'Ukraine missingword' }).reports.length, 0);
});

test('API candidates retain every source cap while the default display stays grouped and bounded', async () => {
  const reports = ['geopolitics', 'economy', 'disasters'].flatMap((category) => Array.from({ length: 80 }, (_, i) => gkgTopicReport({
    url: `https://${category}-${i}.example/report`, themes: [category === 'geopolitics' ? 'MILITARY' : category === 'economy' ? 'WB_698_TRADE' : 'NATURAL_DISASTER'],
    mentionedCountries: ['UA'], category, batch: BATCH, retrievedAt: ISO })));
  const large = createGkgSnapshot({ reports, processedBatches: [{ id: BATCH, retrievedAt: ISO, rows: 240, matchedRecords: 240 }], generatedAt: ISO });
  // Exercise the full published-schema cap independently of upstream sampling quotas.
  for (const category of Object.keys(large.categories)) large.categories[category].reports = reports.filter((report) => report.category === category);
  validateGdeltSnapshot(large, NOW);
  const usgs = { features: Array.from({ length: 100 }, (_, i) => ({ id: `quake-${i}`, geometry: { coordinates: [i / 10, 50] },
    properties: { url: `https://earthquake.usgs.gov/event/${i}`, title: `Earthquake ${i}`, time: NOW - i * 1000 } })) };
  const gdacs = { features: Array.from({ length: 100 }, (_, i) => ({ geometry: { coordinates: [i / 10, 50] }, properties: {
    eventid: i + 1, eventtype: 'FL', name: `Flood ${i}`, fromdate: ISO, country: 'Belgium', affectedcountries: [{ iso2: 'BE' }], url: { report: `https://www.gdacs.org/report/${i}` } } })) };
  const eonetInput = { events: Array.from({ length: 60 }, (_, i) => ({ id: `EONET_${i + 1}`, title: `Curated wildfire ${i}`,
    categories: [{ id: 'wildfires' }], sources: [{ id: 'GDACS', url: `https://www.gdacs.org/report/${i}` }],
    closed: null, geometry: [{ date: ISO }] })) };
  const eonet = await createEonetSnapshot(eonetInput, { retrievedAt: ISO, nowMs: NOW });
  let requests = 0;
  const read = endpoint(intelligenceProxy({ now: () => NOW, fetchImpl: async (url) => { requests++; return Response.json(url === GDELT_SNAPSHOT_URL ? large : url === EONET_QUERY_URL ? eonetInput : url === EONET_SNAPSHOT_URL ? eonet : url.includes('usgs.gov') ? usgs : gdacs); } }));
  const result = await read('/?category=all');
  assert.equal(requests, 4); assert.equal(result.payload.indexRecords.length, 500); assert.equal(result.payload.reports.length, 80);
  assert.ok(result.payload.indexCoverage.byteLength <= 2 * 1024 * 1024);
  assert.deepEqual(result.payload.indexCoverage.sources.map((source) => source.recordCount).sort((a, b) => a - b), [60, 100, 100, 240]);
  assert.equal(result.payload.indexRecords.find((record) => record.sourceId === 'usgs').kind, 'hazard-report');
  assert.equal(result.payload.indexRecords.find((record) => record.sourceId === 'gdelt').kind, 'topic-mention');
  assert.equal(result.payload.indexRecords.find((record) => record.sourceId === 'eonet').kind, 'curated-event');
  await read('/?category=all&q=Ukraine%20military'); assert.equal(requests, 4);
});

test('controlled live fallback also serves arbitrary topic changes from its existing coarse metadata sample', async () => {
  const urls = [];
  const read = endpoint(intelligenceProxy({ now: () => NOW, snapshotReader: null, allowLiveGdeltFallback: true,
    fetchImpl: async (url) => { urls.push(url); return Response.json({ articles: [{ url: 'https://publisher.example/trade', title: 'Trade negotiations resume', seendate: ISO }] }); } }));
  const first = await read('/?category=economy&q=trade'); assert.equal(first.payload.reports.length, 1);
  const second = await read('/?category=economy&q=shipping'); assert.equal(second.payload.reports.length, 0); assert.equal(second.payload.indexRecords.length, 1);
  assert.deepEqual(urls, [gdeltQueryUrl({ category: 'economy', country: '', countryName: '', q: '' })]);
});

test('metadata expiry never freshens old GKG records during a provider failure', async () => {
  let at = NOW; const source = snapshot();
  const read = endpoint(intelligenceProxy({ now: () => at, fetchImpl: async () => at === NOW ? Response.json(source) : new Response('', { status: 503 }) }));
  const first = await read('/?category=economy&q=Ukraine'); assert.equal(first.payload.reports[0].retrievedAt, ISO);
  at += 3600000; const stale = await read('/?category=economy&q=Ukraine');
  assert.equal(stale.payload.sources[0].status, 'stale'); assert.equal(stale.payload.indexRecords[0].retrievedAt, ISO);
  at = Date.parse('2026-10-12T10:00:00.001Z'); const expired = await read('/?category=economy&q=Ukraine');
  assert.equal(expired.payload.indexRecords.length, 0); assert.equal(expired.payload.reports.length, 0);
});

test('legacy API search keeps stronger metadata matches ahead of newer publisher-only matches after grouping', async () => {
  const read = endpoint(intelligenceProxy({ now: () => NOW, snapshotReader: null, allowLiveGdeltFallback: true,
    fetchImpl: async () => Response.json({ articles: [
      { url: 'https://trade.example/newer', title: 'Port negotiations continue', seendate: ISO },
      { url: 'https://publisher.example/older', title: 'Trade negotiations continue', seendate: new Date(NOW - 3600000).toISOString() },
    ] }) }));
  const result = await read('/?category=economy&q=trade');
  assert.equal(result.payload.reports.length, 2);
  assert.equal(result.payload.reports[0].url, 'https://publisher.example/older');
  assert.match(result.payload.reports[0].matchReasons[0], /Title/);
  assert.match(result.payload.reports[1].matchReasons[0], /Publisher domain/);
});
