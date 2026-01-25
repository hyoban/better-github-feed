CREATE INDEX `feed_item_published_at_idx` ON `feed_item` (`published_at`);--> statement-breakpoint
CREATE INDEX `feed_item_type_published_at_idx` ON `feed_item` (`type`,`published_at`);