CREATE TABLE `earth_document_attempts` (
	`job_id` text NOT NULL,
	`fence` integer NOT NULL,
	`claim_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`input_revision` text NOT NULL,
	`basis_receipt_id` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error_code` text,
	`raw_receipt_id` text,
	`publication_id` text,
	`raw_request_digest` text,
	`raw_acquired_at` text,
	`admission_token` text,
	PRIMARY KEY(`job_id`, `fence`)
);
--> statement-breakpoint
CREATE INDEX `earth_document_attempts_claim` ON `earth_document_attempts` (`claim_id`);--> statement-breakpoint
CREATE TABLE `earth_document_publications` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`fence` integer NOT NULL,
	`input_revision` text NOT NULL,
	`raw_receipt_id` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`content_sha256` text NOT NULL,
	`content_key` text NOT NULL,
	`content_bytes` integer NOT NULL,
	`acquired_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`request_digest` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earth_document_publications_attempt` ON `earth_document_publications` (`job_id`,`fence`);--> statement-breakpoint
CREATE INDEX `earth_document_publications_known` ON `earth_document_publications` (`job_id`,`recorded_at`,`fence`);--> statement-breakpoint
CREATE TABLE `earth_document_raw_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`input_revision` text NOT NULL,
	`basis_receipt_id` text NOT NULL,
	`basis_json` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`raw_bytes` integer NOT NULL,
	`raw_key` text NOT NULL,
	`acquired_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earth_document_raw_body` ON `earth_document_raw_receipts` (`job_id`,`raw_sha256`);--> statement-breakpoint
CREATE INDEX `earth_document_raw_known` ON `earth_document_raw_receipts` (`job_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `earth_document_work` (
	`job_id` text PRIMARY KEY NOT NULL,
	`subject_kind` text NOT NULL,
	`plugin_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`item_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`input_revision` text NOT NULL,
	`basis_receipt_id` text NOT NULL,
	`basis_json` text NOT NULL,
	`state` text NOT NULL,
	`due_at` text NOT NULL,
	`checked_at` text,
	`attempt_count` integer NOT NULL,
	`fence` integer NOT NULL,
	`worker_id` text,
	`claim_id` text,
	`lease_token` text,
	`lease_until` text,
	`current_raw_receipt_id` text,
	`current_acquired_at` text,
	`last_raw_receipt_id` text,
	`last_raw_observed_at` text,
	`current_publication_id` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `earth_document_work_subject` ON `earth_document_work` (`plugin_id`,`scope_id`,`item_id`,`policy_id`);--> statement-breakpoint
CREATE INDEX `earth_document_work_due` ON `earth_document_work` (`state`,`due_at`);