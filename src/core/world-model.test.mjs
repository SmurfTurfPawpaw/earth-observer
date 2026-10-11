import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { worldTime, worldRevision, createWorldSourceItem, provisionalWorldEvent } from './world-model.js';

const AT = '2026-10-11T12:00:00.000Z', LATER = '2026-10-11T12:01:00.000Z';
const quake = (changes = {}) => canonicalDiscoveryRecord({ id: 'TEST_ONLY_USGS_001', sourceId: 'usgs', source: 'USGS',
  kind: 'hazard-report', category: 'disasters', title: 'TEST ONLY — M 5.1 source report', eventType: 'EQ',
  url: 'https://earthquake.usgs.gov/earthquakes/eventpage/TEST_ONLY_USGS_001', lat: 50, lon: 4, magnitude: 5.1,
  observedAt: '2026-10-11T11:55:00.000Z', updatedAt: '2026-10-11T11:59:00.000Z', retrievedAt: AT,
  verification: 'Original source report; not independently verified.', ...changes });
const item = (record) => createWorldSourceItem(record, { snapshotId: 'a'.repeat(64), capturedAt: AT, recordedAt: LATER });

test('stable item/event/place identities survive source correction while factual revision changes', async () => {
  const original = await item(quake()), corrected = await item(quake({ magnitude: 5.4, lat: 50.2, updatedAt: LATER }));
  assert.equal(corrected.itemId, original.itemId);
  assert.notEqual(corrected.revision, original.revision);
  const before = provisionalWorldEvent(original), after = provisionalWorldEvent(corrected);
  assert.equal(after.id, before.id); assert.equal(after.place.id, before.place.id);
  assert.equal(after.place.lat, 50.2); assert.equal(after.reportedFacts.magnitude, 5.4);
  assert.equal(after.evidence.revision, corrected.revision);
});

test('retrieval-only heartbeat changes no factual revision and no source date becomes collector time', async () => {
  const first = await worldRevision(quake()), heartbeat = await worldRevision(quake({ retrievedAt: LATER }));
  assert.equal(first.revision, heartbeat.revision);
  assert.equal(first.itemId, heartbeat.itemId);
  const event = provisionalWorldEvent(await item(quake()));
  assert.equal(event.eventTime.at, '2026-10-11T11:55:00.000Z');
  assert.equal(event.sourceTimes.updatedAt, '2026-10-11T11:59:00.000Z');
  assert.deepEqual(event.knowledge, { firstCapturedAt: AT, firstRecordedAt: LATER });
  assert.equal(event.status, 'provisional-source-report'); assert.match(event.note, /not retracted/);
});

test('unknown event date remains unknown and a named source does not establish independent corroboration', async () => {
  const event = provisionalWorldEvent(await item(quake({ observedAt: null, retrievedAt: null })));
  assert.deepEqual(event.eventTime, { at: null, certainty: 'unknown', meaning: 'Source-reported earthquake origin time' });
  assert.equal(event.sourceTimes.retrievedAt, null); assert.equal(event.sourceTimes.publishedAt, null);
  assert.match(event.verification, /not independently verified/);
});

test('country/topic mentions retain source metadata without becoming incident pins', async () => {
  const mention = canonicalDiscoveryRecord({ id: 'TEST_ONLY_GKG_001', sourceId: 'gdelt', kind: 'topic-mention', category: 'geopolitics',
    url: 'https://publisher.test/TEST_ONLY', themes: ['ARMEDCONFLICT'], mentionedCountries: ['BE', 'LV'], indexedAt: AT, retrievedAt: LATER,
    lat: 50, lon: 4 });
  const value = await item(mention);
  assert.equal(value.record.lat, undefined); assert.deepEqual(value.record.mentionedCountries, ['BE', 'LV']);
  assert.equal(provisionalWorldEvent(value), null);
  assert.equal(provisionalWorldEvent(await item(quake({ sourceId: 'gdacs', url: 'https://www.gdacs.org/report.aspx?eventid=1' }))), null);
});

test('public event factory requires consistent immutable evidence and admitted original source links', async () => {
  const value = await item(quake());
  assert.throws(() => provisionalWorldEvent({ ...value, evidence: { ...value.evidence, sourceRecordId: 'different' } }), TypeError);
  await assert.rejects(item(quake({ url: 'https://publisher.test/usgs-copy' })), TypeError);
  await assert.rejects(createWorldSourceItem(quake(), { snapshotId: 'invalid', capturedAt: AT, recordedAt: LATER }), TypeError);
});

test('knowledge dates reject invalid calendars, offsets and unbounded values', () => {
  assert.equal(worldTime('2026-10-11T12:00:00Z'), AT);
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-11', '2026-10-11T12:00:00+00:00', null, 'x'.repeat(200)])
    assert.throws(() => worldTime(value), TypeError);
});
