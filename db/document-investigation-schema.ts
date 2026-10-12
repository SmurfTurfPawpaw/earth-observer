import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// One fixed publication-item policy owns a small due/check row. This is not a
// USGS event or source snapshot, and no visitor action admits work.
export const documentWork = sqliteTable('earth_document_work', {
  jobId: text('job_id').primaryKey(), subjectKind: text('subject_kind').notNull(),
  pluginId: text('plugin_id').notNull(), scopeId: text('scope_id').notNull(), itemId: text('item_id').notNull(),
  policyId: text('policy_id').notNull(), inputRevision: text('input_revision').notNull(),
  basisReceiptId: text('basis_receipt_id').notNull(), basisJson: text('basis_json').notNull(),
  state: text('state').notNull(), dueAt: text('due_at').notNull(), checkedAt: text('checked_at'),
  attemptCount: integer('attempt_count').notNull(), fence: integer('fence').notNull(),
  workerId: text('worker_id'), claimId: text('claim_id'), leaseToken: text('lease_token'), leaseUntil: text('lease_until'),
  currentRawReceiptId: text('current_raw_receipt_id'), currentAcquiredAt: text('current_acquired_at'),
  lastRawReceiptId: text('last_raw_receipt_id'), lastRawObservedAt: text('last_raw_observed_at'),
  currentPublicationId: text('current_publication_id'), errorCode: text('error_code'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('earth_document_work_subject').on(table.pluginId, table.scopeId, table.itemId, table.policyId),
  index('earth_document_work_due').on(table.state, table.dueAt),
]);

// Historical attempts survive fencing, metadata corrections and body revisions.
export const documentAttempts = sqliteTable('earth_document_attempts', {
  jobId: text('job_id').notNull(), fence: integer('fence').notNull(), claimId: text('claim_id').notNull(),
  workerId: text('worker_id').notNull(), inputRevision: text('input_revision').notNull(),
  basisReceiptId: text('basis_receipt_id').notNull(), state: text('state').notNull(),
  startedAt: text('started_at').notNull(), finishedAt: text('finished_at'), errorCode: text('error_code'),
  rawReceiptId: text('raw_receipt_id'), publicationId: text('publication_id'),
  rawRequestDigest: text('raw_request_digest'), rawAcquiredAt: text('raw_acquired_at'), admissionToken: text('admission_token'),
}, table => [primaryKey({ columns: [table.jobId, table.fence] }),
  index('earth_document_attempts_claim').on(table.claimId),
]);

// Immutable raw evidence admission happens before parsing/analysis. Original PDF
// byte hashes and actual DB knowledge clocks are independent of RSS receipts.
export const documentRawReceipts = sqliteTable('earth_document_raw_receipts', {
  receiptId: text('receipt_id').primaryKey(), jobId: text('job_id').notNull(),
  inputRevision: text('input_revision').notNull(), basisReceiptId: text('basis_receipt_id').notNull(),
  basisJson: text('basis_json').notNull(), rawSha256: text('raw_sha256').notNull(), rawBytes: integer('raw_bytes').notNull(),
  rawKey: text('raw_key').notNull(), acquiredAt: text('acquired_at').notNull(), recordedAt: text('recorded_at').notNull(),
}, table => [uniqueIndex('earth_document_raw_body').on(table.jobId, table.rawSha256),
  index('earth_document_raw_known').on(table.jobId, table.recordedAt),
]);

// Only complete, leased admissions are readable. Content has no client-supplied
// analysis publication date: this receipt's transaction date is the authority.
export const documentPublications = sqliteTable('earth_document_publications', {
  receiptId: text('receipt_id').primaryKey(), jobId: text('job_id').notNull(), fence: integer('fence').notNull(),
  inputRevision: text('input_revision').notNull(), rawReceiptId: text('raw_receipt_id').notNull(),
  rawSha256: text('raw_sha256').notNull(), contentSha256: text('content_sha256').notNull(),
  contentKey: text('content_key').notNull(), contentBytes: integer('content_bytes').notNull(),
  acquiredAt: text('acquired_at').notNull(), recordedAt: text('recorded_at').notNull(),
  requestDigest: text('request_digest').notNull(),
}, table => [uniqueIndex('earth_document_publications_attempt').on(table.jobId, table.fence),
  index('earth_document_publications_known').on(table.jobId, table.recordedAt, table.fence),
]);
