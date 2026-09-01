ALTER TABLE `session_objects` ADD `storage_version_id` text;--> statement-breakpoint
ALTER TABLE `session_objects` ADD `pinned_at` text;--> statement-breakpoint
ALTER TABLE `session_objects` ADD `delete_eligible_at` text;--> statement-breakpoint
ALTER TABLE `session_objects` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `session_objects` ADD `deletion_error` text;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `pending_mtime_ms` integer;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `pending_byte_size` integer;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `first_changed_at` text;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `last_changed_at` text;