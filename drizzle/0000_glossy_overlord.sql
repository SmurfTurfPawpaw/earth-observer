CREATE TABLE `earth_observations` (
	`source` text NOT NULL,
	`at` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`record_count` integer NOT NULL,
	PRIMARY KEY(`source`, `at`)
);
--> statement-breakpoint
CREATE INDEX `earth_observations_at` ON `earth_observations` (`at`);