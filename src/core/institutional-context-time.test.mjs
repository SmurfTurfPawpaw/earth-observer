import test from 'node:test';
import assert from 'node:assert/strict';
import { institutionalContextTime, institutionalContextUrl, institutionalContextKey, validateInstitutionalContextTime } from './institutional-context-time.js';

const at = '2025-10-08T12:00:00.000Z', now = Date.parse('2026-10-12T04:10:00.000Z');
const receipt = { capturedAt: '2025-10-08T11:00:00.000Z', recordedAt: at };
const payload = () => ({ available: true, receipt: { ...receipt }, items: [{ publishedAt: at, firstRecordedAt: at, lastRecordedAt: at, evidence: { ...receipt } }] });

test('publication and hosted knowledge cutoffs are independent, canonical and scoped to one snapshot key', () => {
  const reconstruction = institutionalContextTime({ mode: 'history', at, lens: 'reconstruction', playing: true }, now);
  const known = institutionalContextTime({ mode: 'history', at, lens: 'known-then' }, now);
  for (const context of [reconstruction, known]) {
    const query = new URL(institutionalContextUrl('/api/publications?plugin=ecb-press-v1&limit=20', context), 'https://example.test').searchParams;
    assert.equal(query.get('at'), at); assert.equal(query.get('plugin'), 'ecb-press-v1'); assert.equal(query.get('limit'), '20');
    assert.equal(query.get('knownAt'), context === known ? at : null);
  }
  assert.notEqual(institutionalContextKey('publications', reconstruction), institutionalContextKey('publications', known));
  assert.notEqual(institutionalContextKey('publications', known), institutionalContextKey('commission', known));
  assert.equal(institutionalContextUrl('/api/publications?limit=20', institutionalContextTime({ mode: 'live', at }, now)), '/api/publications?limit=20');
  for (const invalid of [null, '2025-02-30T12:00:00.000Z', '2025-10-08T12:00:00', '2027-01-01T00:00:00.000Z'])
    assert.equal(institutionalContextUrl('/api/publications', institutionalContextTime({ mode: 'history', at: invalid }, now)), null);
  const unknown = institutionalContextTime({ mode: 'history', at, lens: 'unknown' }, now);
  assert.equal(institutionalContextUrl('/api/publications', unknown), null);
  assert.notEqual(institutionalContextKey('publications', reconstruction), institutionalContextKey('publications', unknown));
});

test('retrospective evidence may be later; source publication and known-then receipt boundaries must be exact', () => {
  const known = institutionalContextTime({ mode: 'history', at, lens: 'known-then' }, now), reconstruction = { ...known, knownAt: null, lens: 'reconstruction' };
  assert.equal(validateInstitutionalContextTime(payload(), known).items.length, 1);
  const later = payload(); later.receipt.recordedAt = '2026-10-12T00:00:00.000Z';
  assert.equal(validateInstitutionalContextTime(later, reconstruction), later);
  assert.throws(() => validateInstitutionalContextTime(later, known), /knowledge cutoff/);
  for (const mutate of [p => { p.items[0].publishedAt = '2025-10-08T12:00:00.001Z'; },
    p => { p.items[0].evidence.recordedAt = '2025-10-08T12:00:00.001Z'; }, p => { p.items[0].firstRecordedAt = '2025-10-08T12:00:00.001Z'; },
    p => { p.items[0].evidence.capturedAt = '2025-10-08T12:00:00.001Z'; }]) {
    const bad = payload(); mutate(bad); assert.throws(() => validateInstitutionalContextTime(bad, known));
  }
  const unavailable = { available: false, explanation: 'No retained receipt existed.' };
  assert.equal(validateInstitutionalContextTime(unavailable, known), unavailable);
});
