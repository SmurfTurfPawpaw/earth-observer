import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem, worldRevision } from './world-model.js';
import { worldHash } from './world-identity.js';
import { normalizeGdacsSourceItems } from './gdacs-source-items.js';

const AT = '2026-10-11T12:00:00.000Z', PUBLISHED = '2026-10-11T12:00:01.000Z';
const record = (id = 'gdacs:FL:1001:1', changes = {}) => canonicalDiscoveryRecord({ id, sourceId: 'gdacs', source: 'GDACS',
  kind: 'hazard-report', category: 'disasters', title: 'TEST ONLY modeled flood notice', eventType: 'FL',
  url: 'https://www.gdacs.org/report.aspx?eventid=' + id.split(':')[2] + '&episodeid=' + id.split(':')[3] + '&eventtype=FL',
  lat: 50, lon: 4, observedAt: '2026-10-10T11:00:00.000Z', eventEndAt: '2026-10-12T11:00:00.000Z',
  updatedAt: '2026-10-11T11:00:00.000Z', retrievedAt: AT, ...changes });
async function cohort(records = [record()]) {
  records.sort((a, b) => a.id.localeCompare(b.id));
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] };
  const snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt: _retrievedAt, ...value }) => value) });
  const capture = { sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: PUBLISHED, bodySha256: await worldHash(body), recordCount: records.length };
  const items = await Promise.all(records.map(async value => ({ ...await createWorldSourceItem(value,
    { snapshotId, capturedAt: AT, recordedAt: PUBLISHED }), origin: { snapshotId: 'a'.repeat(64), firstCapturedAt: AT,
      firstRecordedAt: PUBLISHED, validation: 'retained-revision-index-only', bodyValidated: false } })));
  const mapped = records.filter(value => Number.isFinite(value.lat) && Number.isFinite(value.lon)).length;
  return { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: PUBLISHED }), readAt: PUBLISHED,
    cohort: capture, items, counts: { returned: records.length, mapped, unmapped: records.length - mapped },
    coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100, completeRetainedCohort: true, completeProviderArchive: false },
    history: { replay: false, future: false }, operational: { status: 'unknown', checkedAt: null } };
}

test('one cited normalized cohort preserves notice episodes, unknown geometry and source interval dates', async () => {
  const value = await cohort([record(), record('gdacs:FL:1001:2', { lat: undefined, lon: undefined })]);
  assert.equal(await normalizeGdacsSourceItems(value), value);
  assert.deepEqual(value.counts, { returned: 2, mapped: 1, unmapped: 1 });
  assert.notEqual(value.items[0].itemId, value.items[1].itemId, 'Episodes retain separate notice identities');
  assert.equal(value.items[0].record.eventEndAt, '2026-10-12T11:00:00.000Z', 'A future source to-date is retained, not an event forecast');
  const heartbeat = await worldRevision(record(undefined, { retrievedAt: '2026-10-11T12:01:00.000Z' }));
  assert.equal(heartbeat.revision, value.items[0].revision, 'Only a retrieval clock changed, so notice facts must not change');
  const emptyEpisode = await cohort([record('gdacs:FL:1001:', { url: 'https://www.gdacs.org/report.aspx?eventid=1001&episodeid=0&eventtype=FL' })]);
  await normalizeGdacsSourceItems(emptyEpisode);
  assert.equal(emptyEpisode.items[0].record.id, 'gdacs:FL:1001:', 'The existing empty/falsy episode identity is never renamed');
});

test('a valid cohort receipt cannot authorize foreign pins, renamed identities or a stale factual revision', async () => {
  const value = await cohort();
  const wrongIdentity = structuredClone(value); wrongIdentity.items[0].itemId = 'item:' + 'b'.repeat(64);
  await assert.rejects(normalizeGdacsSourceItems(wrongIdentity), /source item/);
  const correction = structuredClone(value); correction.items[0].record.lat = 51;
  await assert.rejects(normalizeGdacsSourceItems(correction), /source item/);
  const foreign = structuredClone(value); foreign.items[0].record.url = 'https://foreign.example/report';
  await assert.rejects(normalizeGdacsSourceItems(foreign), /source report|canonical/);
  const wrongEpisode = await cohort([record(undefined, { url: 'https://www.gdacs.org/report.aspx?eventid=1001&episodeid=2&eventtype=FL' })]);
  await assert.rejects(normalizeGdacsSourceItems(wrongEpisode), /notice episode/);
  const repeatedIdentity = await cohort([record(undefined, { url: 'https://www.gdacs.org/report.aspx?eventid=1001&eventid=1002&episodeid=1&eventtype=FL' })]);
  await assert.rejects(normalizeGdacsSourceItems(repeatedIdentity), /notice episode/);
});

test('origin index references cannot masquerade as validated originals or replace the current cohort citation', async () => {
  const value = await cohort();
  const claimedOriginal = structuredClone(value); claimedOriginal.items[0].origin.bodyValidated = true;
  await assert.rejects(normalizeGdacsSourceItems(claimedOriginal), /origin/);
  const wrongCitation = structuredClone(value); wrongCitation.items[0].evidence.snapshotId = value.items[0].origin.snapshotId;
  await assert.rejects(normalizeGdacsSourceItems(wrongCitation), /current verified cohort/);
  const laterKnowledge = structuredClone(value); laterKnowledge.items[0].origin.firstRecordedAt = '2026-10-11T12:01:00.000Z';
  await assert.rejects(normalizeGdacsSourceItems(laterKnowledge), /knowledge/);
});

test('missing geometry and unknown operational checks cannot become broader completeness, current acquisition or replay', async () => {
  const value = await cohort([record(undefined, { lat: undefined, lon: undefined })]);
  await normalizeGdacsSourceItems(value);
  for (const change of [v => v.counts.mapped++, v => v.coverage.completeProviderArchive = true,
    v => v.history.replay = true, v => v.operational.checkedAt = PUBLISHED]) {
    const changed = structuredClone(value); change(changed);
    await assert.rejects(normalizeGdacsSourceItems(changed), /coverage|freshness/);
  }
});
