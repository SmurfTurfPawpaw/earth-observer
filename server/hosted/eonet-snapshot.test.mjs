import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEonetSnapshot, normalizeEonetEvent, validateEonetSnapshot, EONET_QUERY_URL, EONET_SNAPSHOT_MAX_BYTES, EONET_MAX_AGE_MS } from './eonet-snapshot.js';

const at = Date.parse('2026-10-11T12:00:00.000Z'), stamp = new Date(at).toISOString();
const event = (id = 'EONET_1') => ({ id, title: 'Synthetic wildfire reference in Ukraine', description: 'Omitted publisher text', closed: null,
  categories: [{ id: 'wildfires', title: 'Wildfires' }], sources: [{ id: 'GDACS', url: 'https://www.gdacs.org/example?utm_source=test#section' }],
  geometry: [{ date: '2021-01-01T00:00:00Z', type: 'Point', coordinates: [30, 50] },
    { date: '2026-10-10T12:00:00Z', type: 'Point', coordinates: [31, 51] }] });
const snapshot = (events = [event()], time = at) => createEonetSnapshot({ events }, { retrievedAt: new Date(time).toISOString(), nowMs: time });

test('curated metadata keeps separate dates and source links, without article text, inferred country or geometry', async () => {
  const result = await snapshot(), record = result.records[0];
  assert.equal(result.queryUrl, EONET_QUERY_URL); assert.equal(record.kind, 'curated-event');
  assert.equal(record.sourceGeometryAt, '2026-10-10T12:00:00.000Z'); assert.equal(record.closedAt, null);
  assert.equal(record.retrievedAt, stamp); assert.equal(record.publishedAt, null); assert.equal(record.observedAt, null); assert.equal(record.indexedAt, null);
  assert.equal(record.publisherCountry, null); assert.equal(record.url, 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1');
  assert.deepEqual(record.referencedSources, [{ id: 'GDACS', url: 'https://www.gdacs.org/example' }]);
  for (const key of ['description', 'geometry', 'coordinates', 'lat', 'lon', 'country', 'countries', 'eventType', 'magnitude']) assert.equal(Object.hasOwn(record, key), false);
  assert.match(record.verification, /approximate/); assert.deepEqual(record.relatedReports, []);
  assert.equal(result.coverage.atLimit, false); assert.equal(result.coverage.returnedEvents, 1);
});

test('empty and closed events preserve status; missing geometry dates are not replaced with retrieval dates', async () => {
  const closed = { ...event(), closed: '2026-10-09T00:00:00Z', geometry: [] };
  const record = (await snapshot([closed])).records[0];
  assert.equal(record.closedAt, '2026-10-09T00:00:00.000Z'); assert.equal(record.sourceGeometryAt, null);
  assert.deepEqual((await snapshot([])).records, []);
  assert.equal(normalizeEonetEvent({ ...event(), geometry: [{}] }, stamp, at).sourceGeometryAt, null);
});

test('the sample limit is explicit and malformed counts, identities, source lists and dates fail', async () => {
  const limit = await snapshot(Array.from({ length: 60 }, (_, index) => ({ ...event(`EONET_${index + 1}`), title: `Synthetic reference ${index}` })));
  assert.equal(limit.records.length, 60); assert.equal(limit.coverage.atLimit, true);
  await assert.rejects(snapshot(Array.from({ length: 61 }, (_, index) => event(`EONET_${index}`))), /event count/);
  await assert.rejects(snapshot([event(), event()]), /Duplicate/);
  for (const changed of [
    { geometry: [{ date: '2026-10-12T00:00:00Z' }] }, { closed: '2026-10-12T00:00:00Z' },
    { geometry: [{ date: '2026-02-30T00:00:00Z' }] }, { geometry: [{ date: '2026-10-10' }] },
    { geometry: [{ date: '2026-02-31T00:00:00+00:00' }] }, { closed: '2026-02-30T00:00:00-04:00' },
    { categories: [{ id: 'unreviewed', title: 'Unknown' }] }, { sources: [] },
    { sources: Array.from({ length: 5 }, (_, index) => ({ id: `SRC${index}`, url: 'https://example.com/' })) },
  ]) await assert.rejects(snapshot([{ ...event(), ...changed }]));
});

test('valid offset calendars normalize their instant without discarding the source date', async () => {
  const value = await snapshot([{ ...event(), closed: '2026-10-10T23:00:00-04:00', geometry: [{ date: '2026-10-10T23:00:00+02:00' }] }]);
  assert.equal(value.records[0].closedAt, '2026-10-11T03:00:00.000Z');
  assert.equal(value.records[0].sourceGeometryAt, '2026-10-10T21:00:00.000Z');
});

test('source links are references only and reject executable schemes or credentials', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com/file', 'https://user:secret@example.com/']) {
    await assert.rejects(snapshot([{ ...event(), sources: [{ id: 'GDACS', url }] }]), /URL/);
  }
  const shared = await snapshot([{ ...event(), sources: [{ id: 'GDACS', url: 'http://www.gdacs.org/reference' }, { id: 'JTWC', url: 'https://www.metoc.navy.mil/jtwc/' }] }]);
  assert.equal(shared.records[0].referencedSources.length, 2); assert.deepEqual(shared.records[0].relatedReports, []);
});

test('content generation remains stable on fresh retrieval and changes on factual metadata revisions', async () => {
  const initial = await snapshot(), refreshed = await snapshot([event()], at + 60000);
  assert.equal(initial.generation, refreshed.generation); assert.notEqual(initial.retrievedAt, refreshed.retrievedAt);
  const revised = await snapshot([{ ...event(), closed: '2026-10-11T00:00:00Z' }]);
  assert.notEqual(initial.generation, revised.generation);
  const reordered = await snapshot([event('EONET_2'), event('EONET_1')]);
  const normalOrder = await snapshot([event('EONET_1'), event('EONET_2')]);
  assert.equal(reordered.generation, normalOrder.generation);
});

test('consumer rejects tampering, invented location/publication, extra data, future retrieval and expired samples', async () => {
  const initial = await snapshot();
  for (const mutate of [
    (copy) => { copy.records[0].title = 'Different metadata'; },
    (copy) => { copy.records[0].lat = 50; },
    (copy) => { copy.records[0].publishedAt = stamp; },
    (copy) => { copy.records[0].url = 'https://example.com/event'; },
    (copy) => { copy.records[0].referencedSources[0].body = 'Article text'; },
    (copy) => { copy.queryUrl += '&q=visitor'; },
    (copy) => { copy.generation = 'a'.repeat(64); },
  ]) { const copy = structuredClone(initial); mutate(copy); await assert.rejects(validateEonetSnapshot(copy, at)); }
  await assert.rejects(validateEonetSnapshot(initial, at + EONET_MAX_AGE_MS), /expired/);
  await assert.rejects(validateEonetSnapshot(initial, at - 300001), /retrieval window/);
  const oversized = { ...initial, extra: 'x'.repeat(EONET_SNAPSHOT_MAX_BYTES) };
  await assert.rejects(validateEonetSnapshot(oversized, at), /oversized/);
});
