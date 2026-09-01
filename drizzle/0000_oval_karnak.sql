CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`type` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	`available_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`delivered_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_events_event_key_uidx` ON `outbox_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `outbox_events_delivery_idx` ON `outbox_events` (`delivered_at`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `session_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`object_type` text DEFAULT 'raw_session' NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`original_filename` text,
	`checksum_algorithm` text DEFAULT 'sha256' NOT NULL,
	`checksum` text NOT NULL,
	`byte_size` integer NOT NULL,
	`storage_status` text NOT NULL,
	`observed_at` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_objects_session_checksum_uidx` ON `session_objects` (`session_id`,`checksum`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_objects_session_version_uidx` ON `session_objects` (`session_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_objects_key_uidx` ON `session_objects` (`object_key`);--> statement-breakpoint
CREATE INDEX `session_objects_session_created_idx` ON `session_objects` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_installation_id` text NOT NULL,
	`external_id` text NOT NULL,
	`harness` text NOT NULL,
	`format_version` text,
	`adapter_version` text NOT NULL,
	`title` text,
	`working_directory` text,
	`lifecycle_status` text DEFAULT 'unknown' NOT NULL,
	`latest_object_id` text,
	`started_at` text,
	`completed_at` text,
	`last_observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_installation_id`) REFERENCES `source_installations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_owner_source_external_uidx` ON `sessions` (`owner_id`,`source_installation_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `sessions_harness_started_idx` ON `sessions` (`harness`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_lifecycle_observed_idx` ON `sessions` (`lifecycle_status`,`last_observed_at`);--> statement-breakpoint
CREATE TABLE `source_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`harness` text NOT NULL,
	`device_id` text NOT NULL,
	`display_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_installations_owner_harness_device_uidx` ON `source_installations` (`owner_id`,`harness`,`device_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_installation_id` text NOT NULL,
	`source_path` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_installation_id`) REFERENCES `source_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_jobs_source_path_uidx` ON `sync_jobs` (`source_installation_id`,`source_path`);--> statement-breakpoint
CREATE INDEX `sync_jobs_claim_idx` ON `sync_jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE VIEW `session_catalog_v1` AS
SELECT
	`s`.`id`,
	`s`.`external_id`,
	`s`.`harness`,
	`s`.`format_version`,
	`s`.`title`,
	`s`.`working_directory`,
	`s`.`lifecycle_status`,
	`s`.`started_at`,
	`s`.`completed_at`,
	`s`.`last_observed_at`,
	`o`.`version` AS `latest_version`,
	`o`.`checksum` AS `latest_checksum`,
	`o`.`byte_size` AS `latest_byte_size`,
	`o`.`object_key` AS `latest_object_key`,
	`o`.`verified_at` AS `latest_verified_at`
FROM `sessions` `s`
LEFT JOIN `session_objects` `o` ON `o`.`id` = `s`.`latest_object_id`;