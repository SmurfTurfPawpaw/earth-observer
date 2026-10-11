import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Reviewed source scopes share the existing evidence bucket and database. Checks
// are operational; only completed changed facts acquire a historical receipt.
export const pluginState = sqliteTable('earth_plugin_state', {
  pluginId: text('plugin_id').primaryKey(), scopeId: text('scope_id').notNull(),
  checkedAt: text('checked_at'), nextCheckAt: text('next_check_at').notNull(),
  lastSuccessfulAt: text('last_successful_at'), status: text('status').notNull(),
  failureCount: integer('failure_count').notNull(), validatorsJson: text('validators_json'),
  currentReceipt: text('current_receipt'), factsDigest: text('facts_digest'),
  sourceUpdatedAt: text('source_updated_at'), sourceVersion: text('source_version'),
  fence: integer('fence').notNull(), leaseToken: text('lease_token'), leaseUntil: text('lease_until'),
}, table => [index('earth_plugin_state_due').on(table.nextCheckAt)]);

export const pluginCaptures = sqliteTable('earth_plugin_captures', {
  receiptId: text('receipt_id').primaryKey(), pluginId: text('plugin_id').notNull(), scopeId: text('scope_id').notNull(),
  fence: integer('fence').notNull(), capturedAt: text('captured_at').notNull(), recordedAt: text('recorded_at').notNull(),
  factsDigest: text('facts_digest').notNull(), rawSha256: text('raw_sha256').notNull(),
  artifactSha256: text('artifact_sha256').notNull(), rawBytes: integer('raw_bytes').notNull(),
  factsBytes: integer('facts_bytes').notNull(), artifactBytes: integer('artifact_bytes').notNull(),
  sourceUpdatedAt: text('source_updated_at'), sourceVersion: text('source_version'), itemCount: integer('item_count').notNull(),
}, table => [index('earth_plugin_captures_known').on(table.pluginId, table.recordedAt, table.fence)]);

export const pluginRevisions = sqliteTable('earth_plugin_revisions', {
  pluginId: text('plugin_id').notNull(), itemId: text('item_id').notNull(), revision: text('revision').notNull(),
  projectionJson: text('projection_json').notNull(), publishedAt: text('published_at'),
  firstCapturedAt: text('first_captured_at').notNull(), firstRecordedAt: text('first_recorded_at').notNull(),
}, table => [primaryKey({ columns: [table.pluginId, table.itemId, table.revision] }),
  index('earth_plugin_revisions_publication').on(table.pluginId, table.publishedAt)]);

// Membership journals changed and reverted inputs. Absence from a rolling feed
// does not delete a retained publication or rewrite when it became known.
export const pluginMembership = sqliteTable('earth_plugin_membership', {
  receiptId: text('receipt_id').notNull(), itemId: text('item_id').notNull(), revision: text('revision').notNull(),
}, table => [primaryKey({ columns: [table.receiptId, table.itemId] }),
  index('earth_plugin_membership_item').on(table.itemId, table.receiptId)]);

// Bounded current delivery does not scan the historical journal. Historical
// knowledge requests use capture membership; current reads use these small heads.
export const pluginHeads = sqliteTable('earth_plugin_heads', {
  pluginId: text('plugin_id').notNull(), itemId: text('item_id').notNull(), revision: text('revision').notNull(),
  receiptId: text('receipt_id').notNull(), recordedAt: text('recorded_at').notNull(), publishedAt: text('published_at'),
}, table => [primaryKey({ columns: [table.pluginId, table.itemId] }),
  index('earth_plugin_heads_publication').on(table.pluginId, table.publishedAt, table.itemId)]);
