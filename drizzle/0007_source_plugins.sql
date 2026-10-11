CREATE TABLE `earth_plugin_captures` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`fence` integer NOT NULL,
	`captured_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`facts_digest` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`raw_bytes` integer NOT NULL,
	`facts_bytes` integer NOT NULL,
	`artifact_bytes` integer NOT NULL,
	`source_updated_at` text,
	`source_version` text,
	`item_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `earth_plugin_captures_known` ON `earth_plugin_captures` (`plugin_id`,`recorded_at`,`fence`);--> statement-breakpoint
CREATE TABLE `earth_plugin_membership` (
	`receipt_id` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	PRIMARY KEY(`receipt_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `earth_plugin_membership_item` ON `earth_plugin_membership` (`item_id`,`receipt_id`);--> statement-breakpoint
CREATE TABLE `earth_plugin_revisions` (
	`plugin_id` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	`projection_json` text NOT NULL,
	`published_at` text,
	`first_captured_at` text NOT NULL,
	`first_recorded_at` text NOT NULL,
	PRIMARY KEY(`plugin_id`, `item_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `earth_plugin_revisions_publication` ON `earth_plugin_revisions` (`plugin_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `earth_plugin_state` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`checked_at` text,
	`next_check_at` text NOT NULL,
	`last_successful_at` text,
	`status` text NOT NULL,
	`failure_count` integer NOT NULL,
	`validators_json` text,
	`current_receipt` text,
	`facts_digest` text,
	`source_updated_at` text,
	`source_version` text,
	`fence` integer NOT NULL,
	`lease_token` text,
	`lease_until` text
);
--> statement-breakpoint
CREATE INDEX `earth_plugin_state_due` ON `earth_plugin_state` (`next_check_at`);