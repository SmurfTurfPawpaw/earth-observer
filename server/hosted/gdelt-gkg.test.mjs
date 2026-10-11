import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGkgRow, gkgTopicReport, createGkgSnapshot, validateGkgSnapshot, gkgBatchTime, GKG_FIPS_TO_ISO } from './gdelt-gkg.js';
import { createGdeltSnapshotReader, validateGdeltSnapshot } from './gdelt-snapshot.js';
import { groupReports } from './intelligence-sources.js';
import { createEarthRuntime } from '../../worker/index.js';

const NOW = Date.parse('2026-10-11T10:05:00.000Z'), BATCH = '20261011100000', RETRIEVED = new Date(NOW).toISOString();
// Entirely synthetic GKG rows; the fixture does not make real-world news claims.
function row({ batch = BATCH, url = 'https://publisher.example/report', themes = 'WB_698_TRADE;ARMEDCONFLICT;', country = 'GM', collection = '1' } = {}) {
  const values = Array(27).fill('');
  Object.assign(values, { 0: `${batch}-T1`, 1: batch, 2: collection, 3: 'publisher.example', 4: url, 7: themes,
    9: `1#Germany#${country}##51#9#GM`, 18: 'https://example.test/copyrighted-photo.jpg', 22: 'Copyrighted quotation', 26: '<BODY>Article text</BODY>' });
  return values.join('\t');
}
function fixture() {
  return createGkgSnapshot({ reports: parseGkgRow(row(), { batch: BATCH, retrievedAt: RETRIEVED }), generatedAt: RETRIEVED,
    processedBatches: [{ id: BATCH, retrievedAt: RETRIEVED, rows: 1, matchedRecords: 2 }] });
}

test('GKG keeps only WEB links and reviewed theme/country mentions, with no invented publisher or headline', () => {
  const rows = parseGkgRow(row(), { batch: BATCH, retrievedAt: RETRIEVED });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'topic-mention'); assert.match(rows[0].title, /^Topic mention/);
  assert.deepEqual(rows[0].mentionedCountries, ['DE']); assert.equal(GKG_FIPS_TO_ISO.AU, 'AT'); assert.equal(GKG_FIPS_TO_ISO.AS, 'AU');
  assert.equal(GKG_FIPS_TO_ISO.GV, 'GN'); assert.equal(GKG_FIPS_TO_ISO.EK, 'GQ'); assert.equal(GKG_FIPS_TO_ISO.LO, 'SK');
  for (const report of rows) {
    assert.equal(report.indexedAt, '2026-10-11T10:00:00.000Z'); assert.equal(report.retrievedAt, RETRIEVED);
    assert.equal(report.publisherCountry, null); assert.equal(report.publishedAt, null); assert.equal(report.observedAt, null);
    assert.equal(report.lat, undefined); assert.equal(report.lon, undefined); assert.equal(report.body, undefined); assert.equal(report.image, undefined);
    assert.doesNotMatch(JSON.stringify(report), /Article text|quotation|copyrighted-photo|51#/);
  }
  for (const collection of ['2', '3', '6']) assert.deepEqual(parseGkgRow(row({ collection }), { batch: BATCH, retrievedAt: RETRIEVED }), []);
  for (const url of ['javascript:alert(1)', 'https://user:secret@publisher.example/']) assert.deepEqual(parseGkgRow(row({ url }), { batch: BATCH, retrievedAt: RETRIEVED }), []);
  assert.deepEqual(parseGkgRow(row({ themes: 'UNKNOWN_THEME;', country: 'OS' }), { batch: BATCH, retrievedAt: RETRIEVED }), []);
  assert.throws(() => parseGkgRow(row({ batch: '20261011101500' }), { batch: BATCH, retrievedAt: RETRIEVED }), /identity/);
  assert.throws(() => parseGkgRow('x'.repeat(524289), { batch: BATCH, retrievedAt: RETRIEVED }), /limit/);
  assert.throws(() => parseGkgRow('€'.repeat(174763), { batch: BATCH, retrievedAt: RETRIEVED }), /limit/);
  assert.equal(gkgBatchTime('20260230100000'), null); assert.equal(gkgBatchTime('20261011100300'), null);
});

test('snapshot preserves actual processed batches, holes and original retrieval times, and evicts records older than 24h', () => {
  const priorBatch = '20261011093000', priorTime = '2026-10-11T09:35:00.000Z', expired = '20261010090000';
  const reports = [...parseGkgRow(row({ batch: priorBatch, url: 'https://older.example/first' }), { batch: priorBatch, retrievedAt: priorTime }),
    ...parseGkgRow(row(), { batch: BATCH, retrievedAt: RETRIEVED }),
    ...parseGkgRow(row({ batch: expired }), { batch: expired, retrievedAt: '2026-10-10T09:05:00.000Z' })];
  const snapshot = createGkgSnapshot({ reports, generatedAt: RETRIEVED, processedBatches: [
    { id: expired, retrievedAt: '2026-10-10T09:05:00.000Z', rows: 1, matchedRecords: 2 },
    { id: priorBatch, retrievedAt: priorTime, rows: 1, matchedRecords: 2 }, { id: BATCH, retrievedAt: RETRIEVED, rows: 1, matchedRecords: 2 }] });
  assert.deepEqual(snapshot.coverage.processedBatches.map((entry) => entry.id), [priorBatch, BATCH]);
  assert.deepEqual(snapshot.coverage.sampleGaps, ['20261011094500']);
  assert.equal(snapshot.coverage.windowStart, '2026-10-11T09:30:00.000Z');
  assert.equal(snapshot.categories.economy.reports.find((entry) => entry.url.includes('older')).retrievedAt, priorTime);
  assert.deepEqual(validateGdeltSnapshot(snapshot, NOW), snapshot);
});

test('canonical validator rejects body/coordinates, corrupted coverage, provenance, unknown topics, false dates and cap violations', () => {
  const snapshot = fixture(); assert.equal(validateGkgSnapshot(snapshot, NOW).schemaVersion, 2);
  const report = (value) => value.categories.economy.reports[0];
  for (const mutate of [
    (value) => { report(value).body = 'Article text'; }, (value) => { report(value).lat = 51; },
    (value) => { report(value).title = 'Invented incident headline'; }, (value) => { report(value).themes.push('UNREVIEWED'); },
    (value) => { report(value).mentionedCountries.push('ZZ'); }, (value) => { report(value).publisherCountry = 'Germany'; },
    (value) => { report(value).publishedAt = RETRIEVED; }, (value) => { report(value).retrievedAt = '2026-10-11T10:04:00.000Z'; },
    (value) => { value.coverage.sampleGaps.push('20261011094500'); }, (value) => { value.coverage.processedBatches[0].rows = 50001; },
    (value) => { value.categories.economy.reports = Array(81).fill(report(value)); },
  ]) { const invalid = structuredClone(snapshot); mutate(invalid); assert.throws(() => validateGkgSnapshot(invalid, NOW)); }
  assert.throws(() => validateGkgSnapshot(snapshot, NOW + 86400001), /expired/);
});

test('a large same-country publisher sequence cannot crowd out all international domains, and topic labels never corroborate each other', () => {
  const reports = Array.from({ length: 200 }, (_, i) => gkgTopicReport({ url: `https://dense.example/${i}`, themes: ['WB_698_TRADE'], mentionedCountries: ['US'], batch: BATCH, retrievedAt: RETRIEVED, category: 'economy' }));
  for (let i = 0; i < 12; i++) reports.push(gkgTopicReport({ url: `https://international-${i}.example/story`, themes: ['WB_698_TRADE'], mentionedCountries: [i % 2 ? 'DE' : 'BE'], batch: BATCH, retrievedAt: RETRIEVED, category: 'economy' }));
  const snapshot = createGkgSnapshot({ reports, generatedAt: RETRIEVED, processedBatches: [{ id: BATCH, retrievedAt: RETRIEVED, rows: 212, matchedRecords: 212 }] });
  assert.equal(snapshot.categories.economy.reports.length, 80);
  assert.equal(snapshot.categories.economy.reports.filter((report) => report.source.startsWith('international')).length, 12);
  const grouped = groupReports(snapshot.categories.economy.reports);
  assert.equal(grouped.length, 80); assert.ok(grouped.every((report) => report.relatedReports.length === 0));
});

test('all-topic serving reserves each GKG category even when current diplomacy records sort first', () => {
  const reports = ['geopolitics', 'economy', 'disasters'].flatMap((category) => Array.from({ length: 80 }, (_, index) => ({
    kind: 'topic-mention', sourceId: 'gdelt', category, source: `${category}.example`, url: `https://${category}.example/${index}`,
    title: 'Topic mention', indexedAt: `2026-10-11T${category === 'geopolitics' ? '10' : '09'}:00:00.000Z` })));
  const selected = groupReports(reports);
  assert.equal(selected.length, 80);
  for (const category of ['geopolitics', 'economy', 'disasters']) assert.ok(selected.filter((report) => report.category === category).length >= 10);
});

test('quota relaxation revisits skipped single-record publishers without inventing or duplicating rows', () => {
  const make = (index, publisher = `publisher-${index}`) => gkgTopicReport({ url: `https://${publisher}.example/${index}`,
    themes: ['WB_698_TRADE'], mentionedCountries: ['UA'], batch: BATCH, retrievedAt: RETRIEVED, category: 'economy' });
  const batch = { id: BATCH, retrievedAt: RETRIEVED, rows: 120, matchedRecords: 120 };
  for (const reports of [Array.from({ length: 120 }, (_, i) => make(i)), Array.from({ length: 12 }, (_, i) => make(i)),
    Array.from({ length: 120 }, (_, i) => make(i, 'only-publisher'))]) {
    const snapshot = createGkgSnapshot({ reports, generatedAt: RETRIEVED, processedBatches: [batch] });
    const selected = snapshot.categories.economy.reports;
    assert.equal(selected.length, Math.min(80, reports.length));
    assert.equal(new Set(selected.map((report) => report.url)).size, selected.length);
    assert.ok(selected.every((report) => reports.includes(report)), 'all records retain their original provenance');
    assert.deepEqual(validateGkgSnapshot(snapshot, NOW), snapshot);
    const repeat = createGkgSnapshot({ reports: [...reports].reverse(), generatedAt: RETRIEVED, processedBatches: [batch] });
    assert.deepEqual(repeat.categories.economy.reports.map((report) => report.url), selected.map((report) => report.url), 'selection is deterministic for equivalent rows');
  }
});

test('shared GKG reader filters country mentions and reviewed topics, never publisher country, live queries or stale invented timestamps', async () => {
  let time = NOW, requests = 0;
  const read = createGdeltSnapshotReader({ now: () => time, fetchImpl: async () => { requests++; return requests === 1 ? Response.json(fixture()) : new Response('', { status: 503 }); } });
  const filter = (overrides = {}) => ({ category: 'economy', country: '', countryName: '', q: '', ...overrides });
  const german = await read(filter({ country: 'DE', countryName: 'Germany', q: 'trade' }));
  assert.equal(german.records.length, 1); assert.equal(german.state.mode, 'scheduled-gkg'); assert.equal(german.state.countryMeaning, 'country-mentioned');
  assert.match(german.state.coverage, /not publisher country or incident location/);
  assert.equal((await read(filter({ country: 'US' }))).records.length, 0);
  assert.equal((await read(filter({ q: 'publisher' }))).records.length, 1);
  assert.equal(requests, 1);
  time += 1800001; const stale = await read(filter());
  assert.equal(stale.state.status, 'stale'); assert.equal(stale.records[0].retrievedAt, RETRIEVED); assert.equal(requests, 2);
  time = NOW + 86400001; assert.equal((await read(filter())).state.status, 'unavailable');
});

test('individual old batches leave an otherwise usable cached snapshot after their own 24h expiry', async () => {
  const oldBatch = '20261010101500', oldRetrieved = '2026-10-10T10:20:00.000Z';
  const snapshot = createGkgSnapshot({ generatedAt: RETRIEVED, reports: [
    ...parseGkgRow(row({ batch: oldBatch, url: 'https://old.example/report' }), { batch: oldBatch, retrievedAt: oldRetrieved }),
    ...parseGkgRow(row(), { batch: BATCH, retrievedAt: RETRIEVED })], processedBatches: [
    { id: oldBatch, retrievedAt: oldRetrieved, rows: 1, matchedRecords: 2 }, { id: BATCH, retrievedAt: RETRIEVED, rows: 1, matchedRecords: 2 }] });
  let time = NOW;
  const reader = createGdeltSnapshotReader({ now: () => time, fetchImpl: async () => time === NOW ? Response.json(snapshot) : new Response('', { status: 503 }) });
  const filters = { category: 'economy', country: '', q: '' };
  assert.equal((await reader(filters)).records.length, 2);
  time += 7200000;
  const older = await reader(filters);
  assert.equal(older.state.status, 'stale'); assert.equal(older.records.length, 1); assert.equal(older.records[0].retrievedAt, RETRIEVED);
  assert.deepEqual(older.state.processedBatches.map((entry) => entry.id), [BATCH]); assert.deepEqual(older.state.sampleGaps, []);
});

test('Worker consumes the same GKG contract and country filters without downloading archives or querying DOC API', async () => {
  const urls = [];
  const runtime = createEarthRuntime({ now: () => NOW, fetchImpl: async (url) => { urls.push(String(url)); return Response.json(fixture()); } });
  const get = async (query) => (await runtime.fetch(new Request(`https://earth.example/earth/api/intelligence?category=economy&${query}`), {}, {})).json();
  const germany = await get('country=DE&q=trade');
  assert.equal(germany.sources[0].mode, 'scheduled-gkg'); assert.equal(germany.reports.length, 1);
  assert.equal(germany.reports[0].lat, undefined); assert.equal(germany.reports[0].kind, 'topic-mention');
  assert.equal((await get('country=BE')).reports.length, 0); assert.equal(urls.length, 1);
  assert.match(urls[0], /releases\/download\/intelligence-data\/gdelt.snapshot.json$/);
  assert.doesNotMatch(urls[0], /api.gdeltproject|gkg.csv.zip/);
});
