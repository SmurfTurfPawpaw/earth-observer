CREATE TABLE `earth_collection_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`collected_at` text NOT NULL,
	`input_digest` text NOT NULL,
	`record_count` integer NOT NULL,
	`revision` text NOT NULL
);
