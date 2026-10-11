import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

// Completed bounded candidate admission survives isolate loss and changed-input coalescing.
// Current-source joins address one exact receipt; no full-journal scan is required.
export const investigationAdmissions = sqliteTable('earth_investigation_admissions', {
  sourceId: text('source_id').notNull(),
  capturedAt: text('captured_at').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  policyId: text('policy_id').notNull(),
  basisRecordedAt: text('basis_recorded_at').notNull(),
  candidateCount: integer('candidate_count').notNull(),
  admittedAt: text('admitted_at').notNull(),
}, table => [primaryKey({ columns: [table.sourceId, table.capturedAt, table.snapshotId, table.policyId] })]);
