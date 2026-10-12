import { canonicalDiscoveryRecord } from './discovery-index.js';
import { worldTime, isWorldDigest, worldHash } from './world-identity.js';
export { worldTime, isWorldDigest, worldHash } from './world-identity.js';

export const WORLD_MODEL_SCHEMA_VERSION = 1;
export const WORLD_MODEL_LIMITS = Object.freeze({ sources: 4, records: 500, events: 100, snapshotBytes: 1024 * 1024,
  batchStatements: 25, sqlJsonBytes: 256 * 1024, publicationChunks: 8, collectionFutureMs: 300000, publicationClockSkewMs: 5000 });
export const WORLD_SOURCE_IDS = Object.freeze(['usgs', 'gdacs', 'eonet', 'gdelt']);
export const WORLD_MODEL_NOTE = 'Provisional source reports, not independent verification. An item absent from a bounded sample is not retracted, disproved or finished.';
export const WORLD_HISTORY_NOTE = 'The selected knowledge cutoff includes only source captures first recorded by this platform by then. Source event dates remain separate; missing earlier coverage is not reconstructed.';

function sourceRecord(value) {
  const record = canonicalDiscoveryRecord(value);
  if (!record || record.sourceId === 'usgs' && !/^https:\/\/earthquake\.usgs\.gov\//.test(record.url) ||
      record.sourceId === 'gdacs' && !/^https:\/\/(?:www\.)?gdacs\.org\//.test(record.url))
    throw new TypeError('Use admitted source metadata and original provider links');
  return record;
}

/** Stable source identity; source facts and retrieval clocks do not rename an item. */
export async function worldItemIdentity(value) {
  const record = sourceRecord(value);
  return `item:${await worldHash([record.sourceId, record.id])}`;
}

/** Same factual boundary as the existing collection digest, for one canonical item. */
export async function worldRevision(value) {
  const record = sourceRecord(value), { retrievedAt: _retrievedAt, ...facts } = record;
  return { itemId: await worldItemIdentity(record), revision: await worldHash(facts), sourceId: record.sourceId,
    sourceRecordId: record.id, record };
}

export async function createWorldSourceItem(value, { snapshotId, capturedAt, recordedAt } = {}) {
  if (!isWorldDigest(snapshotId)) throw new TypeError('Use an immutable source snapshot identity');
  const revision = await worldRevision(value);
  return { schemaVersion: WORLD_MODEL_SCHEMA_VERSION, ...revision, capturedAt: worldTime(capturedAt), recordedAt: worldTime(recordedAt),
    evidence: { schemaVersion: WORLD_MODEL_SCHEMA_VERSION, itemId: revision.itemId, revision: revision.revision,
      sourceId: revision.sourceId, sourceRecordId: revision.sourceRecordId, snapshotId } };
}

/** Narrow geographic seed only. Topic/country mentions never become incident pins. */
export function provisionalWorldEvent(item) {
  const record = sourceRecord(item?.record);
  if (record.sourceId !== 'usgs' || record.kind !== 'hazard-report' || record.eventType !== 'EQ' ||
      !Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null;
  if (!/^item:[a-f0-9]{64}$/.test(item.itemId) || !isWorldDigest(item.revision) || !isWorldDigest(item.evidence?.snapshotId) ||
      item.evidence.itemId !== item.itemId || item.evidence.revision !== item.revision || item.evidence.sourceId !== record.sourceId ||
      item.evidence.sourceRecordId !== record.id) throw new TypeError('The event must cite its exact source revision');
  const key = item.itemId.slice(5);
  return { schemaVersion: WORLD_MODEL_SCHEMA_VERSION, id: `event:usgs:${key}`, kind: 'earthquake', status: 'provisional-source-report',
    title: record.title, source: { id: record.sourceId, name: record.source, url: record.url }, evidence: { ...item.evidence },
    place: { id: `place:usgs:${key}`, lat: record.lat, lon: record.lon,
      meaning: 'Source-reported earthquake epicenter; not an inferred country or independently verified location', evidence: { ...item.evidence } },
    eventTime: { at: record.observedAt, meaning: record.timeMeaning || 'Source-reported earthquake origin time', certainty: record.observedAt ? 'source-reported' : 'unknown' },
    sourceTimes: { publishedAt: record.publishedAt, observedAt: record.observedAt, updatedAt: record.updatedAt,
      indexedAt: record.indexedAt, retrievedAt: record.retrievedAt },
    knowledge: { firstCapturedAt: worldTime(item.capturedAt), firstRecordedAt: worldTime(item.recordedAt) },
    reportedFacts: { magnitude: record.magnitude ?? null, reviewStatus: record.reviewStatus || null },
    verification: record.verification, note: WORLD_MODEL_NOTE };
}
