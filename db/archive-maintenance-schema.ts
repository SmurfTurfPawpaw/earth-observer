import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Staged only: a signed owner wake may claim this scope; visitor reads cannot.
// Lease/due and publication clocks are database clocks, never user-supplied times.
export const archiveMaintenance = sqliteTable('earth_archive_maintenance', {
  scopeId: text('scope_id').primaryKey(), verifiedFrom: text('verified_from').notNull(), verifiedThrough: text('verified_through').notNull(),
  pendingRangesJson: text('pending_ranges_json').notNull(), candidateJson: text('candidate_json').notNull(),
  tailDueAt: text('tail_due_at').notNull(), overlapDueAt: text('overlap_due_at').notNull(), nextDueAt: text('next_due_at').notNull(),
  checkedAt: text('checked_at'), lastSuccessfulAt: text('last_successful_at'), lastMode: text('last_mode'),
  status: text('status').notNull(), failureCount: integer('failure_count').notNull(),
  fence: integer('fence').notNull(), leaseToken: text('lease_token'), leaseUntil: text('lease_until'),
  admittedChunkId: text('admitted_chunk_id'), admittedFence: integer('admitted_fence'),
}, table => [index('earth_archive_maintenance_due').on(table.nextDueAt)]);

// Original interval receipts remain immutable. These bounded day projections keep
// disjoint first-coverage proofs, not just a later daily snapshot. The exact same
// archive receipt published_at supplies every newly admitted piece's knownAt.
export const archiveCoverageDays = sqliteTable('earth_archive_coverage_days', {
  scopeId: text('scope_id').notNull(), day: text('day').notNull(), generation: integer('generation').notNull(),
  firstProofAt: text('first_proof_at').notNull(), completeKnownAt: text('complete_known_at'),
  firstProofJson: text('first_proof_json').notNull(),
  rangeFrom: text('range_from').notNull(), rangeTo: text('range_to').notNull(),
}, table => [primaryKey({ columns: [table.scopeId, table.day] }),
  index('earth_archive_coverage_days_known').on(table.scopeId, table.firstProofAt, table.day),
  index('earth_archive_coverage_days_complete').on(table.scopeId, table.completeKnownAt, table.day)]);

// Owner-only materialization cursor. Reads use the new calendar only once every
// committed scope receipt through the current archive edition has been visited.
export const archiveDayState = sqliteTable('earth_archive_day_state', {
  scopeId: text('scope_id').primaryKey(), materializedOrder: integer('materialized_order').notNull(),
  status: text('status').notNull(), checkedAt: text('checked_at'),
  fence: integer('fence').notNull(), leaseToken: text('lease_token'), leaseUntil: text('lease_until'),
  admissionToken: text('admission_token'), admittedChunkId: text('admitted_chunk_id'),
});
