CREATE TABLE `earth_investigation_admissions` (
	`source_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`basis_recorded_at` text NOT NULL,
	`candidate_count` integer NOT NULL,
	`admitted_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `captured_at`, `snapshot_id`, `policy_id`)
);
