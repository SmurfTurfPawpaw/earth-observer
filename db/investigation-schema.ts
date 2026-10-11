import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Separate bounded work queue. No live scene/collection publication pointer is modified here.
export const investigationJobs = sqliteTable('earth_investigation_jobs', {
  jobId: text('job_id').primaryKey(),
  eventId: text('event_id').notNull(),
  itemId: text('item_id').notNull(),
  inputRevision: text('input_revision').notNull(),
  policyId: text('policy_id').notNull(),
  sourceRecordId: text('source_record_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  basisCapturedAt: text('basis_captured_at').notNull(),
  basisRecordedAt: text('basis_recorded_at').notNull(),
  state: text('state').notNull(),
  priority: integer('priority').notNull(),
  dueAt: text('due_at').notNull(),
  attemptCount: integer('attempt_count').notNull(),
  fence: integer('fence').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  supersededBy: text('superseded_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'),
  artifactKey: text('artifact_key'),
  artifactSha256: text('artifact_sha256'),
  errorCode: text('error_code'),
}, (table) => [
  uniqueIndex('earth_investigation_jobs_input').on(table.eventId, table.inputRevision, table.policyId),
  index('earth_investigation_jobs_due').on(table.state, table.dueAt, table.priority, table.jobId),
  index('earth_investigation_jobs_event').on(table.eventId, table.policyId, table.createdAt),
  index('earth_investigation_jobs_created').on(table.createdAt, table.jobId),
]);

// Latest accepted input per event/policy. Late enqueues cannot replace a newer retained basis.
export const investigationHeads = sqliteTable('earth_investigation_heads', {
  eventId: text('event_id').notNull(),
  policyId: text('policy_id').notNull(),
  jobId: text('job_id').notNull(),
  basisRecordedAt: text('basis_recorded_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.eventId, table.policyId] })]);

// Monotonic fencing separates attempts; immutable R2 refs retain acquired detail independently of success.
export const investigationAttempts = sqliteTable('earth_investigation_attempts', {
  jobId: text('job_id').notNull(),
  fence: integer('fence').notNull(),
  workerId: text('worker_id').notNull(),
  leaseToken: text('lease_token').notNull(),
  state: text('state').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  errorCode: text('error_code'),
  rawKey: text('raw_key'),
  rawSha256: text('raw_sha256'),
  artifactKey: text('artifact_key'),
  artifactSha256: text('artifact_sha256'),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.fence] }),
  index('earth_investigation_attempts_started').on(table.startedAt, table.jobId),
]);
