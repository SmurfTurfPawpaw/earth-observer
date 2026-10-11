import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

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
