CREATE TABLE `feed_item_read` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`feed_item_id` text NOT NULL,
	`read_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feed_item_read_user_id_idx` ON `feed_item_read` (`user_id`);--> statement-breakpoint
CREATE INDEX `feed_item_read_feed_item_id_idx` ON `feed_item_read` (`feed_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_item_read_user_feed_item_idx` ON `feed_item_read` (`user_id`,`feed_item_id`);