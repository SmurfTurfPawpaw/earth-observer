CREATE TABLE `earth_coverage_cells` (
	`sector_id` integer PRIMARY KEY NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`status` text NOT NULL,
	`failure_count` integer NOT NULL,
	`last_fence` integer NOT NULL,
	`source_basis_json` text,
	`summary_json` text
);
--> statement-breakpoint
CREATE TABLE `earth_coverage_priority` (
	`task_key` text PRIMARY KEY NOT NULL,
	`sector_id` integer NOT NULL,
	`reason` text NOT NULL,
	`priority` integer NOT NULL,
	`enqueued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`attempts` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `earth_coverage_priority_due` ON `earth_coverage_priority` (`next_attempt_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `earth_coverage_priority_expiry` ON `earth_coverage_priority` (`expires_at`);--> statement-breakpoint
CREATE TABLE `earth_coverage_state` (
	`policy_id` text PRIMARY KEY NOT NULL,
	`next_sector` integer NOT NULL,
	`next_due_at` text NOT NULL,
	`fence` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`admitted_token` text,
	`last_wake_at` text,
	`last_completed_at` text,
	`last_error` text,
	`sweep_count` integer NOT NULL
);
