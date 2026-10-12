-- Drizzle generated the schema/snapshot/journal. Its SQLite rebuild copied the
-- new column from the old table; use an equivalent bounded ADD COLUMN instead
-- to preserve the existing live cursor, lease, receipts and processing clocks.
ALTER TABLE `earth_coverage_state` ADD COLUMN `catchup_slots` integer NOT NULL DEFAULT 0 CONSTRAINT `earth_coverage_catchup_bound` CHECK(typeof(`catchup_slots`)='integer' AND `catchup_slots` BETWEEN 0 AND 120);
