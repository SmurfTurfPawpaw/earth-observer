import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUPING_NOTE, groupReports } from './intelligence-grouping.js';
import { GROUPING_NOTE as SERVER_NOTE, groupReports as serverGrouping } from '../../server/hosted/intelligence-sources.js';

// Synthetic source records, not real hazards or news claims.
const NOW = Date.parse('2026-10-11T12:00:00Z');
const row = (id, values = {}) => ({ id, sourceId: 'gdelt', source: `${id}.example`, url: `https://${id}.example/source`,
  category: 'economy', title: 'Regional port trade negotiations resume', indexedAt: new Date(NOW).toISOString(),
  retrievedAt: new Date(NOW + 1000).toISOString(), verification: 'Publisher report; claims unverified', relatedReports: [], ...values });

test('legacy server exports are the shared implementation and retain caution wording', () => {
  assert.equal(serverGrouping, groupReports); assert.equal(SERVER_NOTE, GROUPING_NOTE);
  assert.match(GROUPING_NOTE, /do not establish independent confirmation/);
});
test('default feeds are chronological while relevance mode preserves primary link and group order', () => {
  const ranked = row('highest-match', { indexedAt: new Date(NOW - 3600000).toISOString(), matchReasons: ['Reviewed topic matched exactly'] });
  const unrelated = row('next-match', { category: 'geopolitics', title: 'Election polls released', indexedAt: new Date(NOW - 7200000).toISOString() });
  const recent = row('lower-match', { indexedAt: new Date(NOW).toISOString(), matchReasons: ['Publisher prefix matched'] });
  const input = [ranked, unrelated, recent]; for (const item of input) { Object.freeze(item.relatedReports); Object.freeze(item); } Object.freeze(input);
  const defaultGroups = groupReports(input); assert.deepEqual(defaultGroups.map((item) => item.id), ['lower-match', 'next-match']); assert.equal(defaultGroups[0].relatedReports[0].id, 'highest-match');
  const relevantGroups = groupReports(input, 80, { preserveOrder: true }); assert.deepEqual(relevantGroups.map((item) => item.id), ['highest-match', 'next-match']); assert.equal(relevantGroups[0].relatedReports[0].id, 'lower-match');
  for (const item of relevantGroups.flatMap((primary) => [primary, ...primary.relatedReports])) {
    const original = input.find((candidate) => candidate.id === item.id);
    for (const key of ['url', 'source', 'indexedAt', 'retrievedAt', 'verification']) assert.equal(item[key], original[key]);
    assert.equal('confidence' in item, false); assert.equal('confirmed' in item, false);
  }
  assert.deepEqual(input.map((item) => item.relatedReports), [[], [], []]);
});
test('query grouping keeps highest ranked duplicate URL and never groups machine topic labels', () => {
  const high = row('high', { url: 'https://same.example/source', indexedAt: new Date(NOW - 3600000).toISOString() });
  const newer = row('newer', { url: high.url });
  assert.equal(groupReports([high, newer], 80, { preserveOrder: true })[0].id, 'high');
  assert.equal(groupReports([high, newer])[0].id, 'newer');
  const topics = [row('topic-one', { kind: 'topic-mention' }), row('topic-two', { kind: 'topic-mention' }), row('ordinary')];
  for (const options of [{}, { preserveOrder: true }]) {
    const groups = groupReports(topics, 80, options); assert.equal(groups.length, 3); assert.equal(groups.every((item) => item.relatedReports.length === 0), true);
  }
});
test('related link cap keeps original links without modifying dates or pretending they corroborate', () => {
  const input = Array.from({ length: 8 }, (_, index) => row(`publisher-${index}`));
  const groups = groupReports(input, 80, { preserveOrder: true });
  assert.equal(groups.length, 2); assert.deepEqual(groups.map((item) => item.relatedReports.length), [5, 1]);
  const output = groups.flatMap((item) => [item, ...item.relatedReports]);
  assert.deepEqual(output.map((item) => item.url), input.map((item) => item.url));
  assert.equal(output.every((item) => item.indexedAt === input[0].indexedAt), true);
  assert.equal(groups.flatMap((item) => item.relatedReports).every((item) => /possible shared or syndicated/.test(item.relatedReason)), true);
});
test('earthquake grouping still requires source difference and plausible location/time association', () => {
  const hazard = row('scientific', { sourceId: 'usgs', source: 'USGS', category: 'disasters', eventType: 'EQ', title: 'Quake A', lat: 50, lon: 4, observedAt: new Date(NOW).toISOString() });
  const nearby = row('modeled', { sourceId: 'gdacs', source: 'GDACS', category: 'disasters', eventType: 'EQ', title: 'Quake B', lat: 50.1, lon: 4.1, observedAt: new Date(NOW - 3600000).toISOString() });
  const output = groupReports([hazard, nearby], 80, { preserveOrder: true }); assert.equal(output.length, 1); assert.match(output[0].relatedReports[0].relatedReason, /may use the same measurements/);
  for (const changed of [{ ...nearby, source: 'USGS' }, { ...nearby, lat: 0, lon: 0 }, { ...nearby, observedAt: new Date(NOW - 13 * 3600000).toISOString() }, { ...nearby, category: 'economy' }]) assert.equal(groupReports([hazard, changed]).length, 2);
});
test('caps and provider diversity preserve input ranking among chosen groups', () => {
  const input = [
    ...Array.from({ length: 100 }, (_, index) => row(`earthquake-${index}`, { sourceId: 'usgs', source: 'USGS', category: 'disasters', title: `Quake ${index}`, observedAt: new Date(NOW - index * 1000).toISOString() })),
    ...Array.from({ length: 20 }, (_, index) => row(`flood-${index}`, { sourceId: 'gdacs', source: 'GDACS', category: 'disasters', title: `Flood ${index}`, observedAt: new Date(NOW + index * 1000).toISOString() })),
  ];
  const selected = groupReports(input, 80, { preserveOrder: true }); assert.equal(selected.length, 80); assert.equal(selected.filter((item) => item.sourceId === 'gdacs').length, 10);
  const positions = selected.map((item) => input.findIndex((original) => original.url === item.url)); assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(groupReports(input, 0).length, 0);
  assert.equal(groupReports(Array.from({ length: 240 }, (_, index) => row(`topic-${index}`, { kind: 'topic-mention' })), 999).length, 200);
});
