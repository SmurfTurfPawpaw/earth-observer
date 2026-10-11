CREATE TABLE `earth_aircraft_observations` (
	`scope_id` text NOT NULL,
	`collected_at` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`record_count` integer NOT NULL,
	`scope_type` text NOT NULL,
	`scope_json` text NOT NULL,
	`observed_at_ms` integer,
	`observed_at_source` text NOT NULL,
	PRIMARY KEY(`scope_id`, `collected_at`)
);
--> statement-breakpoint
CREATE INDEX `earth_aircraft_observations_collected_at` ON `earth_aircraft_observations` (`collected_at`);