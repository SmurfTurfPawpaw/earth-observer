CREATE TABLE `earth_world_captures` (
	`source_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `captured_at`)
);
--> statement-breakpoint
CREATE INDEX `earth_world_captures_source_recorded_capture` ON `earth_world_captures` (`source_id`,`recorded_at`,`captured_at`);--> statement-breakpoint
CREATE TABLE `earth_world_observations` (
	`item_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`revision` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `captured_at`)
);
--> statement-breakpoint
CREATE INDEX `earth_world_observations_recorded_capture` ON `earth_world_observations` (`recorded_at`,`captured_at`);--> statement-breakpoint
CREATE TABLE `earth_world_revisions` (
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	`source_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`first_captured_at` text NOT NULL,
	`first_recorded_at` text NOT NULL,
	`event_id` text,
	`event_at` text,
	`projection_json` text,
	PRIMARY KEY(`item_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `earth_world_revisions_source_event` ON `earth_world_revisions` (`source_id`,`event_at`,`item_id`);--> statement-breakpoint
CREATE TABLE `earth_world_sources` (
	`source_id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
