import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMAND_SUBJECTS, DEMAND_COUNTRIES, reviewedDemandSearch, isDemandProductionOrigin } from './demand-subjects.js';
import { GKG_THEMES } from '../../server/hosted/gdelt-gkg.js';
import { ECONOMICS_COUNTRIES } from './economics-catalog.js';

test('light demand catalog matches the reviewed themes and explicit supported countries', () => {
  const themes = DEMAND_SUBJECTS.filter((subject) => subject.kind === 'theme');
  assert.equal(themes.length, 26);
  assert.deepEqual(Object.fromEntries(themes.map((subject) => [subject.theme, [subject.category, subject.label]])), GKG_THEMES);
  assert.deepEqual([...DEMAND_COUNTRIES].sort(), ECONOMICS_COUNTRIES.map((country) => country.iso2).filter((code) => /^[A-Z]{2}$/.test(code) && code !== 'JG').sort());
  assert.equal(new Set(DEMAND_SUBJECTS.map((subject) => subject.id)).size, DEMAND_SUBJECTS.length);
  assert.equal(isDemandProductionOrigin('https://giovannicallebaut.com'), true);
  for (const origin of ['http://giovannicallebaut.com', 'https://preview.giovannicallebaut.com', 'https://giovannicallebaut.com.evil.test', 'http://localhost:4174', 'https://earth.sites.example']) assert.equal(isDemandProductionOrigin(origin), false);
});
test('only exact normalized reviewed full labels/IDs or blank overviews produce a minimal payload', () => {
  assert.deepEqual(reviewedDemandSearch({ category: 'all', country: ' be ', q: '  Armed   CONFLICT ' }), { subjectId: 'gkg:ARMEDCONFLICT', country: 'BE', consent: true });
  assert.deepEqual(reviewedDemandSearch({ category: 'economy', q: 'econ_inflation' }), { subjectId: 'gkg:ECON_INFLATION', country: '', consent: true });
  assert.deepEqual(reviewedDemandSearch({ country: 'XK' }), { subjectId: 'overview:country', country: 'XK', consent: true });
  assert.equal(reviewedDemandSearch({}).subjectId, 'overview:all');
  assert.equal(reviewedDemandSearch({ category: 'disasters', q: '   ' }).subjectId, 'category:disasters');
  for (const filters of [{ q: 'conflict' }, { q: 'Armed conflict near my house' }, { q: 'publisher.example' }, { q: 'person@example.com' }, { q: '51.02,4.50' }, { q: 'utm-id-unique-123' }, { q: 'Trade', category: 'disasters' }, { country: 'ZZ' }, { country: 'WLD' }, { country: 'JG' }, { category: 'unknown' }, { q: { toString() { throw Error('Must not coerce arbitrary objects'); } } }]) assert.equal(reviewedDemandSearch(filters), null);
});
