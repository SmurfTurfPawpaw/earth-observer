CREATE TABLE `earth_plugin_heads` (
	`plugin_id` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` text NOT NULL,
	`receipt_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`published_at` text,
	PRIMARY KEY(`plugin_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `earth_plugin_heads_publication` ON `earth_plugin_heads` (`plugin_id`,`published_at`,`item_id`);