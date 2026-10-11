import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Publication receipts are isolated from live summary captures. Rows referenced by
// a receipt are complete; unfinished membership/revision writes are not visible.
export const archiveChunks = sqliteTable('earth_archive_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scopeId: text('scope_id').notNull(),
  chunkId: text('chunk_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  rawSha256: text('raw_sha256').notNull(),
  capturedAt: text('captured_at').notNull(),
  publishedAt: text('published_at').notNull(),
  kind: text('kind').notNull(),
  recordCount: integer('record_count').notNull(),
  policyJson: text('policy_json').notNull(),
}, (table) => [
  uniqueIndex('earth_archive_chunks_scope_chunk').on(table.scopeId, table.chunkId),
  index('earth_archive_chunks_scope_publication').on(table.scopeId, table.publishedAt, table.id),
]);

export const archiveMembership = sqliteTable('earth_archive_membership', {
  scopeId: text('scope_id').notNull(),
  chunkId: text('chunk_id').notNull(),
  itemId: text('item_id').notNull(),
  revision: text('revision').notNull(),
  eventId: text('event_id').notNull(),
  eventAt: text('event_at').notNull(),
  sourceUpdatedAt: text('source_updated_at'),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  magnitude: real('magnitude').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.chunkId, table.itemId] }),
  index('earth_archive_membership_scope_event').on(table.scopeId, table.eventAt, table.itemId),
  index('earth_archive_membership_scope_item_update').on(table.scopeId, table.itemId, table.sourceUpdatedAt, table.chunkId),
]);

// Only count-matched, unsliced interval responses can assert catalog coverage.
// A correction receipt never manufactures complete interval coverage.
export const archiveCoverage = sqliteTable('earth_archive_coverage', {
  scopeId: text('scope_id').notNull(),
  chunkId: text('chunk_id').notNull(),
  rangeFrom: text('range_from').notNull(),
  rangeTo: text('range_to').notNull(),
  expectedCount: integer('expected_count').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.chunkId] }),
  index('earth_archive_coverage_scope_range').on(table.scopeId, table.rangeFrom, table.rangeTo),
]);

// Greatest dated provider revision wins. Equal-date conflicts keep the first
// committed selection while all conflicting evidence remains in membership.
export const archiveHeads = sqliteTable('earth_archive_heads', {
  scopeId: text('scope_id').notNull(),
  itemId: text('item_id').notNull(),
  revision: text('revision').notNull(),
  eventId: text('event_id').notNull(),
  eventAt: text('event_at').notNull(),
  sourceUpdatedAt: text('source_updated_at'),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  magnitude: real('magnitude').notNull(),
  chunkId: text('chunk_id').notNull(),
  publicationOrder: integer('publication_order').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.itemId] }),
  index('earth_archive_heads_scope_event').on(table.scopeId, table.eventAt, table.itemId),
]);
