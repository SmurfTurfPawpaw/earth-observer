import { canonicalDiscoveryRecord } from './discovery-index.js';
import { worldRevision, WORLD_MODEL_LIMITS } from './world-model.js';
import { worldTime, worldHash, isWorldDigest } from './world-identity.js';

export const GDACS_SOURCE_ITEM_LIMITS = Object.freeze({ records: 100, bytes: 256 * 1024, deadlineMs: 10000 });
export const GDACS_SOURCE_ITEM_NOTE = 'Retained GDACS notice metadata, not raw provider originals or independently observed impacts. Notice points are indicative locations, not affected-area boundaries. An absent notice does not establish withdrawal or completion.';
const TYPES = new Set(['EQ', 'TC', 'FL', 'VO', 'WF', 'DR']);
const PUBLICATION_FUTURE_MS = WORLD_MODEL_LIMITS.collectionFutureMs + WORLD_MODEL_LIMITS.publicationClockSkewMs;
const time = (value) => { if (worldTime(value) !== value) throw new Error('GDACS cohort dates must be canonical UTC'); return value; };
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const mappedGdacsRecord = record => Number.isFinite(record?.lat) && Math.abs(record.lat) <= 90 &&
  Number.isFinite(record.lon) && Math.abs(record.lon) <= 180;

/** Current normalized source cohort only; neither a generic event nor a historical scene. */
export async function normalizeGdacsSourceItems(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'source-item-cohort' || value.configured !== true || value.available !== true ||
      value.mode !== 'current-retained-cohort' || value.source?.id !== 'gdacs' || value.source.url !== 'https://www.gdacs.org/' ||
      value.source.attribution !== 'Global Disaster Alert and Coordination System, GDACS' || !Array.isArray(value.items) ||
      value.items.length > GDACS_SOURCE_ITEM_LIMITS.records || bytes(value) > GDACS_SOURCE_ITEM_LIMITS.bytes)
    throw new Error('Invalid bounded GDACS source-item cohort');
  const cohort = value.cohort;
  if (!cohort || cohort.sourceId !== 'gdacs' || !isWorldDigest(cohort.snapshotId) || !isWorldDigest(cohort.bodySha256) ||
      !isWorldDigest(value.version) || !Number.isInteger(cohort.recordCount) || cohort.recordCount !== value.items.length)
    throw new Error('Invalid GDACS cohort receipt');
  time(cohort.capturedAt); time(cohort.publishedAt); time(value.readAt);
  // readAt is the host response clock, not a knowledge cutoff. Keep the real
  // database date across the existing small host/database clock-skew allowance.
  if (Date.parse(cohort.capturedAt) > Date.parse(cohort.publishedAt) + PUBLICATION_FUTURE_MS ||
      Date.parse(cohort.publishedAt) > Date.parse(value.readAt) + WORLD_MODEL_LIMITS.publicationClockSkewMs)
    throw new Error('GDACS cohort clocks do not match retained publication');
  if (await worldHash({ sourceId: 'gdacs', snapshotId: cohort.snapshotId, capturedAt: cohort.capturedAt,
    publishedAt: cohort.publishedAt }) !== value.version) throw new Error('GDACS edition does not bind its completed receipt');

  const seen = new Set(), records = [];
  for (const item of value.items) {
    const record = canonicalDiscoveryRecord(item?.record), parts = /^gdacs:([A-Z]{2}):([^:\s]{1,100}):([^:\s]{0,100})$/.exec(record?.id || '');
    let url; try { url = new URL(record?.url); } catch { throw new Error('Invalid GDACS source report link'); }
    if (!record || record.sourceId !== 'gdacs' || record.kind !== 'hazard-report' || !parts || !TYPES.has(parts[1]) ||
        parts[1] !== record.eventType || record.category !== 'disasters' || record.publishedAt !== null || record.indexedAt !== null ||
        url.protocol !== 'https:' || !['gdacs.org', 'www.gdacs.org'].includes(url.hostname) || url.username || url.password ||
        await worldHash(record) !== await worldHash(item.record)) throw new Error('Invalid canonical GDACS notice metadata');
    if (url.pathname !== '/report.aspx' || url.searchParams.getAll('eventid').length !== 1 ||
        url.searchParams.getAll('eventtype').length !== 1 || url.searchParams.get('eventid') !== parts[2] ||
        url.searchParams.get('eventtype') !== parts[1] || url.searchParams.getAll('episodeid').length > 1 ||
        (parts[3] ? url.searchParams.get('episodeid') !== parts[3] : ![null, '', '0'].includes(url.searchParams.get('episodeid'))))
      throw new Error('GDACS source report link does not identify the retained notice episode');
    const revision = await worldRevision(record), evidence = item.evidence, origin = item.origin;
    if (item.schemaVersion !== 1 || item.sourceId !== 'gdacs' || item.sourceRecordId !== record.id || item.itemId !== revision.itemId ||
        item.revision !== revision.revision || seen.has(item.itemId) || item.capturedAt !== cohort.capturedAt || item.recordedAt !== cohort.publishedAt ||
        !evidence || evidence.schemaVersion !== 1 || evidence.sourceId !== 'gdacs' || evidence.sourceRecordId !== record.id ||
        evidence.itemId !== item.itemId || evidence.revision !== item.revision || evidence.snapshotId !== cohort.snapshotId)
      throw new Error('GDACS source item does not cite its current verified cohort');
    if (!origin || origin.validation !== 'retained-revision-index-only' || origin.bodyValidated !== false || !isWorldDigest(origin.snapshotId))
      throw new Error('GDACS origin must remain a separately qualified index reference');
    time(origin.firstCapturedAt); time(origin.firstRecordedAt);
    if (origin.firstCapturedAt > cohort.capturedAt || origin.firstRecordedAt > cohort.publishedAt ||
        Date.parse(origin.firstCapturedAt) > Date.parse(origin.firstRecordedAt) + PUBLICATION_FUTURE_MS)
      throw new Error('GDACS origin knowledge is later than its completed cohort');
    seen.add(item.itemId); records.push(record);
  }
  if (records.some((record, index) => index && record.id.localeCompare(records[index - 1].id) <= 0))
    throw new Error('GDACS cohort source identities are not uniquely ordered');
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] };
  if (await worldHash(body) !== cohort.bodySha256 || await worldHash({ ...body,
    records: records.map(({ retrievedAt: _retrievedAt, ...record }) => record) }) !== cohort.snapshotId)
    throw new Error('GDACS cohort does not reproduce the cited normalized snapshot');
  const mapped = records.filter(mappedGdacsRecord).length;
  if (value.counts?.returned !== records.length || value.counts.mapped !== mapped || value.counts.unmapped !== records.length - mapped ||
      value.coverage?.mode !== 'retained-seven-day-notice-sample' || value.coverage.windowDays !== 7 ||
      value.coverage.maxRecords !== GDACS_SOURCE_ITEM_LIMITS.records || value.coverage.completeRetainedCohort !== true ||
      value.coverage.completeProviderArchive !== false || value.history?.replay !== false || value.history.future !== false ||
      value.operational?.status !== 'unknown' || value.operational.checkedAt !== null)
    throw new Error('GDACS coverage or operational freshness exceeds its retained contract');
  return value;
}
