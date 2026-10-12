CREATE TABLE `earth_archive_coverage_days` (
	`scope_id` text NOT NULL,
	`day` text NOT NULL,
	`generation` integer NOT NULL,
	`first_proof_at` text NOT NULL,
	`complete_known_at` text,
	`first_proof_json` text NOT NULL,
	`range_from` text NOT NULL,
	`range_to` text NOT NULL,
	PRIMARY KEY(`scope_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `earth_archive_coverage_days_known` ON `earth_archive_coverage_days` (`scope_id`,`first_proof_at`,`day`);--> statement-breakpoint
CREATE INDEX `earth_archive_coverage_days_complete` ON `earth_archive_coverage_days` (`scope_id`,`complete_known_at`,`day`);--> statement-breakpoint
CREATE TABLE `earth_archive_day_state` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`materialized_order` integer NOT NULL,
	`status` text NOT NULL,
	`checked_at` text,
	`fence` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`admission_token` text,
	`admitted_chunk_id` text
);
--> statement-breakpoint
CREATE TABLE `earth_archive_maintenance` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`verified_from` text NOT NULL,
	`verified_through` text NOT NULL,
	`pending_ranges_json` text NOT NULL,
	`candidate_json` text NOT NULL,
	`tail_due_at` text NOT NULL,
	`overlap_due_at` text NOT NULL,
	`next_due_at` text NOT NULL,
	`checked_at` text,
	`last_successful_at` text,
	`last_mode` text,
	`status` text NOT NULL,
	`failure_count` integer NOT NULL,
	`fence` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`admitted_chunk_id` text,
	`admitted_fence` integer
);
--> statement-breakpoint
CREATE INDEX `earth_archive_maintenance_due` ON `earth_archive_maintenance` (`next_due_at`);--> statement-breakpoint
CREATE INDEX `earth_archive_chunks_scope_order` ON `earth_archive_chunks` (`scope_id`,`id`);