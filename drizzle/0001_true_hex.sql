ALTER TABLE `sync_jobs` ADD `source_mtime_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `source_byte_size` integer;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `last_checksum` text;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `last_attempt_at` text;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `last_succeeded_at` text;