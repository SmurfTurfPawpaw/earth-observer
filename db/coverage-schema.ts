import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Fixed-size monitoring projections. Evidence/history remains in its source tables.
// Claims and completion use the primary database clock and a fenced owner lease.
export const coverageState = sqliteTable('earth_coverage_state', {
  policyId: text('policy_id').primaryKey(), nextSector: integer('next_sector').notNull(),
  nextDueAt: text('next_due_at').notNull(), fence: integer('fence').notNull(),
  leaseToken: text('lease_token'), leaseUntil: text('lease_until'), admittedToken: text('admitted_token'),
  lastWakeAt: text('last_wake_at'), lastCompletedAt: text('last_completed_at'), lastError: text('last_error'),
  sweepCount: integer('sweep_count').notNull(), catchupSlots: integer('catchup_slots').notNull().default(0),
}, table => [check('earth_coverage_catchup_bound', sql`typeof(${table.catchupSlots}) = 'integer' AND ${table.catchupSlots} >= 0 AND ${table.catchupSlots} <= 120`)]);
export const coverageCells = sqliteTable('earth_coverage_cells', {
  sectorId: integer('sector_id').primaryKey(), lastAttemptAt: text('last_attempt_at'),
  lastSuccessAt: text('last_success_at'), status: text('status').notNull(),
  failureCount: integer('failure_count').notNull(), lastFence: integer('last_fence').notNull(),
  sourceBasisJson: text('source_basis_json'), summaryJson: text('summary_json'),
});
export const coveragePriority = sqliteTable('earth_coverage_priority', {
  taskKey: text('task_key').primaryKey(), sectorId: integer('sector_id').notNull(), reason: text('reason').notNull(),
  priority: integer('priority').notNull(), enqueuedAt: text('enqueued_at').notNull(), expiresAt: text('expires_at').notNull(),
  nextAttemptAt: text('next_attempt_at').notNull(), attempts: integer('attempts').notNull(), generation: text('generation').notNull(),
}, table => [index('earth_coverage_priority_due').on(table.nextAttemptAt, table.expiresAt),
  index('earth_coverage_priority_expiry').on(table.expiresAt)]);
