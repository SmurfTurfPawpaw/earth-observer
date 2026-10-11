CREATE TABLE `earth_archive_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`captured_at` text NOT NULL,
	`published_at` text NOT NULL,
	`kind` text NOT NULL,
	`record_count` integer NOT NULL,
	`policy_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earth_archive_chunks_scope_chunk` ON `earth_archive_chunks` (`scope_id`,`chunk_id`);--> statement-breakpoint
CREATE INDEX `earth_archive_chunks_scope_publication` ON `earth_archive_chunks` (`scope_id`,`published_at`,`id`);--> statement-breakpoint
CREATE TABLE `earth_archive_coverage` (
	`scope_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`range_from` text NOT NULL,
	`range_to` text NOT NULL,
	`expected_count` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `chunk_id`)
);
--> statement-breakpoint
CREATE INDEX `earth_archive_coverage_scope_range` ON `earth_archive_coverage` (`scope_id`,`range_from`,`range_to`);--> statement-breakpoint
CREATE TABLE `earth_archive_heads` (
	`scope_id` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	`event_id` text NOT NULL,
	`event_at` text NOT NULL,
	`source_updated_at` text,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`magnitude` real NOT NULL,
	`chunk_id` text NOT NULL,
	`publication_order` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `earth_archive_heads_scope_event` ON `earth_archive_heads` (`scope_id`,`event_at`,`item_id`);--> statement-breakpoint
CREATE TABLE `earth_archive_membership` (
	`scope_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	`event_id` text NOT NULL,
	`event_at` text NOT NULL,
	`source_updated_at` text,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`magnitude` real NOT NULL,
	PRIMARY KEY(`scope_id`, `chunk_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `earth_archive_membership_scope_event` ON `earth_archive_membership` (`scope_id`,`event_at`,`item_id`);--> statement-breakpoint
CREATE INDEX `earth_archive_membership_scope_item_update` ON `earth_archive_membership` (`scope_id`,`item_id`,`source_updated_at`,`chunk_id`);--> statement-breakpoint
CREATE TABLE `earth_investigation_attempts` (
	`job_id` text NOT NULL,
	`fence` integer NOT NULL,
	`worker_id` text NOT NULL,
	`lease_token` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error_code` text,
	`raw_key` text,
	`raw_sha256` text,
	`artifact_key` text,
	`artifact_sha256` text,
	PRIMARY KEY(`job_id`, `fence`)
);
--> statement-breakpoint
CREATE INDEX `earth_investigation_attempts_started` ON `earth_investigation_attempts` (`started_at`,`job_id`);--> statement-breakpoint
CREATE TABLE `earth_investigation_heads` (
	`event_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`job_id` text NOT NULL,
	`basis_recorded_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `policy_id`)
);
--> statement-breakpoint
CREATE TABLE `earth_investigation_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`item_id` text NOT NULL,
	`input_revision` text NOT NULL,
	`policy_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`basis_captured_at` text NOT NULL,
	`basis_recorded_at` text NOT NULL,
	`state` text NOT NULL,
	`priority` integer NOT NULL,
	`due_at` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`fence` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`superseded_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`artifact_key` text,
	`artifact_sha256` text,
	`error_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earth_investigation_jobs_input` ON `earth_investigation_jobs` (`event_id`,`input_revision`,`policy_id`);--> statement-breakpoint
CREATE INDEX `earth_investigation_jobs_due` ON `earth_investigation_jobs` (`state`,`due_at`,`priority`,`job_id`);--> statement-breakpoint
CREATE INDEX `earth_investigation_jobs_event` ON `earth_investigation_jobs` (`event_id`,`policy_id`,`created_at`);