import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryIndex, canonicalDiscoveryRecord, canonicalDiscoveryUrl, DISCOVERY_REVIEWED_TOPICS, DISCOVERY_INDEX_MAX_BYTES } from './discovery-index.js';
import { GKG_THEMES } from '../../server/hosted/gdelt-gkg.js';

const NOW = Date.parse('2026-10-11T10:00:00.000Z'), ISO = new Date(NOW).toISOString();
const topic = (overrides = {}) => ({ sourceId: 'gdelt', source: 'publisher.example', url: 'https://publisher.example/report',
  kind: 'topic-mention', category: 'geopolitics', title: 'Topic mention · Armed conflict, Elections, Military',
  themes: ['ARMEDCONFLICT', 'ELECTION', 'MILITARY', 'SANCTIONS', 'WB_698_TRADE'], mentionedCountries: ['UA'],
  publishedAt: null, observedAt: null, indexedAt: ISO, retrievedAt: ISO, ...overrides });
const hazard = (overrides = {}) => ({ sourceId: 'gdacs', source: 'GDACS', url: 'https://www.gdacs.org/report/one', title: 'Flood in Belgium',
  category: 'disasters', countries: ['BE'], country: 'Belgium', observedAt: ISO, retrievedAt: ISO, eventType: 'FL', lat: 50, lon: 4, ...overrides });
const replace = (index, records, id = records[0]?.sourceId || 'gdelt', generation = 'one', extra = {}) => index.replaceSource({ id, generation, records,
  expiresAt: new Date(NOW + 86400000).toISOString(), coverage: 'Synthetic bounded metadata fixture', ...extra });

test('reviewed browser taxonomy exactly matches the source-validated GKG labels', () => {
  assert.deepEqual(DISCOVERY_REVIEWED_TOPICS, GKG_THEMES);
});

test('all query terms match metadata country names and reviewed topics beyond the title first three', () => {
  const index = createDiscoveryIndex({ now: () => NOW }); replace(index, [topic()]);
  const found = index.search({ q: 'Ukraine sanctions', category: 'geopolitics' });
  assert.equal(found.reports.length, 1); assert.match(found.reports[0].matchReasons.join('\n'), /Country mentioned “Ukraine \(UA\)” matches “ukraine”/);
  assert.match(found.reports[0].matchReasons.join('\n'), /Reviewed topic “Sanctions” matches “sanctions”/);
  assert.doesNotMatch(found.reports[0].title, /Sanctions/);
  assert.equal(index.search({ q: 'Ukraine nonexistent' }).reports.length, 0);
  assert.equal(index.search({ q: 'publisher trade', category: 'economy' }).reports.length, 1);
  assert.match(index.search({ q: 'publisher trade', category: 'economy' }).reports[0].title, /Trade/);
  assert.doesNotMatch(index.search({ q: 'publisher trade', category: 'economy' }).reports[0].title, /Armed conflict/);
  assert.equal(index.search({ q: 'ukr sanctions' }).reports.length, 1);
  assert.equal(found.reports[0].score, undefined); assert.equal(found.reports[0].confidence, undefined);
});

test('country aliases normalize accents and keep mentioned, reported and publisher roles separate', () => {
  const index = createDiscoveryIndex({ now: () => NOW });
  replace(index, [topic({ mentionedCountries: ['GB', 'CI'], url: 'https://publisher.example/mentions' }),
    { sourceId: 'gdelt', url: 'https://french.example/title', source: 'french.example', title: 'Port trade report', category: 'economy', publisherCountry: 'France', retrievedAt: ISO }]);
  replace(index, [hazard()], 'gdacs');
  assert.equal(index.search({ q: 'UK trade' }).reports.length, 1);
  assert.equal(index.search({ q: 'Ivory Coast' }).reports.length, 1);
  assert.equal(index.search({ q: "Cote d'Ivoire" }).reports.length, 1);
  assert.match(index.search({ q: 'Belgium' }).reports[0].matchReasons.join('\n'), /Reported country/);
  assert.match(index.search({ q: 'France' }).reports[0].matchReasons.join('\n'), /Publisher country/);
  assert.equal(index.search({ country: 'FR' }).reports.length, 0, 'publisher country cannot become an incident-country filter');
  assert.equal(index.search({ country: 'BE' }).reports[0].sourceId, 'gdacs');
});

test('canonical URL plus kind merges same-batch categories and rejects unsafe links without retaining article content', () => {
  const index = createDiscoveryIndex({ now: () => NOW });
  replace(index, [topic({ url: 'https://publisher.example/report?utm_source=one#fragment', body: 'Copyrighted body', image: 'https://example/photo', lat: 51, lon: 8 }),
    topic({ category: 'economy', url: 'https://publisher.example/report', themes: ['WB_698_TRADE'], mentionedCountries: ['BE'] }),
    topic({ url: 'javascript:alert(1)' }), topic({ url: 'https://user:password@publisher.example/' })]);
  assert.equal(index.getState().recordCount, 1);
  const record = index.search().reports[0]; assert.equal(record.url, 'https://publisher.example/report');
  assert.deepEqual(record.categories, ['geopolitics', 'economy']); assert.deepEqual(record.mentionedCountries, ['BE', 'UA']);
  for (const key of ['body', 'image', 'lat', 'lon']) assert.equal(key in record, false);
  assert.equal(canonicalDiscoveryUrl('https://example.org/path?fbclid=x&a=1#one'), 'https://example.org/path?a=1');
  assert.equal(canonicalDiscoveryRecord(topic({ publishedAt: ISO })), null);
});

test('a newer batch cannot refresh older country mentions or retain a superseded generation', () => {
  const index = createDiscoveryIndex({ now: () => NOW });
  const old = topic({ indexedAt: new Date(NOW - 3600000).toISOString(), mentionedCountries: ['UA'] }), fresh = topic({ mentionedCountries: ['BE'] });
  assert.equal(replace(index, [old, fresh]), true);
  assert.deepEqual(index.search().reports[0].mentionedCountries, ['BE']); assert.equal(index.search({ q: 'Ukraine' }).reports.length, 0);
  const version = index.getState().indexVersion; assert.equal(replace(index, [old, fresh]), false); assert.equal(index.getState().indexVersion, version);
  assert.equal(replace(index, [topic({ url: 'https://new.example/source', mentionedCountries: ['FR'] })], 'gdelt', 'two'), true);
  assert.equal(index.getState().recordCount, 1); assert.equal(index.search({ q: 'Ukraine' }).reports.length, 0); assert.equal(index.search({ q: 'France' }).reports.length, 1);
});

test('source expiry and individual GKG batch expiry preserve actual dates and allow old official event times', () => {
  let at = NOW; const index = createDiscoveryIndex({ now: () => at });
  replace(index, [topic({ indexedAt: new Date(NOW - 23 * 3600000).toISOString() })]);
  replace(index, [hazard({ observedAt: new Date(NOW - 7 * 86400000).toISOString() })], 'gdacs');
  assert.equal(index.getState().recordCount, 2); at += 2 * 3600000;
  const found = index.search(); assert.equal(found.reports.length, 1); assert.equal(found.reports[0].sourceId, 'gdacs'); assert.equal(found.reports[0].retrievedAt, ISO);
  assert.equal(found.reports[0].observedAt, new Date(NOW - 7 * 86400000).toISOString());
  at = NOW + 86400001; assert.equal(index.getState().recordCount, 0);
});

test('record and serialized-byte caps are hard limits and malicious unused fields are never copied', () => {
  const rows = Array.from({ length: 800 }, (_, i) => topic({ url: `https://publisher.example/${i}`, body: 'x'.repeat(3000) }));
  const index = createDiscoveryIndex({ now: () => NOW, maxRecords: 10000, maxBytes: 10000000 }); replace(index, rows);
  assert.equal(index.getState().recordCount, 600); assert.ok(index.getState().byteLength <= DISCOVERY_INDEX_MAX_BYTES); assert.ok(index.getState().omittedRecords > 0);
  const tiny = createDiscoveryIndex({ now: () => NOW, maxBytes: 3000 }); replace(tiny, rows);
  assert.ok(tiny.getState().byteLength <= 3000); assert.ok(tiny.getState().recordCount > 0 && tiny.getState().recordCount < 600);
  assert.doesNotMatch(JSON.stringify(tiny.getState().records), /xxx/);
});

test('relevance ordering retains publisher/topic diversity without pretending to rank truth or popularity', () => {
  const index = createDiscoveryIndex({ now: () => NOW });
  const dense = Array.from({ length: 30 }, (_, i) => topic({ url: `https://dense.example/${i}`, themes: ['WB_698_TRADE'], category: 'economy' }));
  replace(index, [...dense, topic({ url: 'https://other.example/one', category: 'economy', themes: ['WB_698_TRADE'], indexedAt: new Date(NOW - 60000).toISOString() })]);
  const found = index.search({ q: 'trade', limit: 8 }); assert.equal(found.reports.length, 8);
  assert.ok(found.reports.slice(0, 5).some((row) => row.publisher === 'other.example')); assert.match(found.ranking, /not a confidence, truth or popularity score/);
  assert.equal(index.search({ q: 'trade', limit: 0 }).reports.length, 0);
});

test('API payload generation metadata recreates the same portable local index and bounded search', () => {
  const original = createDiscoveryIndex({ now: () => NOW }); replace(original, [topic()]); replace(original, [hazard()], 'gdacs');
  const state = original.getState(), client = createDiscoveryIndex({ now: () => NOW });
  assert.equal(client.replacePayload({ indexRecords: state.records, indexCoverage: { schemaVersion: 1, sources: state.sources } }), true);
  assert.deepEqual(client.search({ q: 'Ukraine trade' }).reports, original.search({ q: 'Ukraine trade' }).reports);
  assert.throws(() => client.search({ q: 'x'.repeat(65) })); assert.throws(() => client.search({ country: 'ZZ' })); assert.throws(() => client.search({ category: 'unknown' }));
});
