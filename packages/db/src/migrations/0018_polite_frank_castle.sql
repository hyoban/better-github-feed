CREATE INDEX `feed_item_hidden_published_at_id_idx` ON `feed_item` (`hidden`,`published_at`,`id`);--> statement-breakpoint
PRAGMA optimize;
