import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export { archiveChunks, archiveMembership, archiveCoverage, archiveHeads } from './world-archive-schema';
export { investigationJobs, investigationHeads, investigationAttempts } from './investigation-schema';

// Immutable source observations index private R2 content-addressed snapshots.
export const observations = sqliteTable('earth_observations', {
  source: text('source').notNull(),
  at: text('at').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  recordCount: integer('record_count').notNull(),
}, (table) => [
  primaryKey({ columns: [table.source, table.at] }),
  index('earth_observations_at').on(table.at),
]);

// A single durable public revision lets connected isolates discover new prepared data.
// No source records, visitor identities or private contribution data belong here.
export const collectionRevision = sqliteTable('earth_collection_revision', {
  id: integer('id').primaryKey(),
  collectedAt: text('collected_at').notNull(),
  inputDigest: text('input_digest').notNull(),
  recordCount: integer('record_count').notNull(),
  revision: text('revision').notNull(),
});

// Aircraft captures have their own protocol and must not enter report history queries.
export const aircraftObservations = sqliteTable('earth_aircraft_observations', {
  scopeId: text('scope_id').notNull(),
  collectedAt: text('collected_at').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  recordCount: integer('record_count').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeJson: text('scope_json').notNull(),
  observedAtMs: integer('observed_at_ms'),
  observedAtSource: text('observed_at_source').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.collectedAt] }),
  index('earth_aircraft_observations_collected_at').on(table.collectedAt),
]);

// Immutable item revisions reference the existing source snapshot evidence body.
// Collector capture and first hosted knowledge are deliberately different dates.
export const worldRevisions = sqliteTable('earth_world_revisions', {
  itemId: text('item_id').notNull(),
  revision: text('revision').notNull(),
  sourceId: text('source_id').notNull(),
  sourceRecordId: text('source_record_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  firstCapturedAt: text('first_captured_at').notNull(),
  firstRecordedAt: text('first_recorded_at').notNull(),
  eventId: text('event_id'),
  eventAt: text('event_at'),
  projectionJson: text('projection_json'),
}, (table) => [
  primaryKey({ columns: [table.itemId, table.revision] }),
  index('earth_world_revisions_source_event').on(table.sourceId, table.eventAt, table.itemId),
]);

// Changed/reverted facts are journaled; ordinary identical checks reuse history.
export const worldObservations = sqliteTable('earth_world_observations', {
  itemId: text('item_id').notNull(),
  capturedAt: text('captured_at').notNull(),
  revision: text('revision').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.itemId, table.capturedAt] }),
  index('earth_world_observations_recorded_capture').on(table.recordedAt, table.capturedAt),
]);

// Per-source projection progress avoids reprocessing unchanged source snapshots.
export const worldSources = sqliteTable('earth_world_sources', {
  sourceId: text('source_id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  capturedAt: text('captured_at').notNull(),
  recordedAt: text('recorded_at').notNull(),
});

// Only completed projections create a receipt. Readers resolve exact snapshot
// membership by capture and hosted availability, excluding partial/late item rows.
export const worldCaptures = sqliteTable('earth_world_captures', {
  sourceId: text('source_id').notNull(),
  capturedAt: text('captured_at').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.capturedAt] }),
  index('earth_world_captures_source_recorded_capture').on(table.sourceId, table.recordedAt, table.capturedAt),
]);
