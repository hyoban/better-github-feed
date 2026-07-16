CREATE TABLE `local_feed_server_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`data_epoch` text NOT NULL,
	`activity_reconciled_at` integer,
	`activity_cleanup_enabled_at` integer
);
--> statement-breakpoint
INSERT OR IGNORE INTO `local_feed_server_state` (
	`id`, `data_epoch`, `activity_reconciled_at`, `activity_cleanup_enabled_at`
)
VALUES (1, 'local-feed-v1-' || lower(hex(randomblob(16))), NULL, NULL);
--> statement-breakpoint
CREATE TRIGGER `local_feed_data_epoch_reset_cleanup`
AFTER UPDATE OF `data_epoch` ON `local_feed_server_state`
WHEN OLD.`data_epoch` <> NEW.`data_epoch`
BEGIN
	UPDATE `local_feed_server_state`
	SET `activity_reconciled_at` = NULL,
		`activity_cleanup_enabled_at` = NULL
	WHERE `id` = NEW.`id`;
END;
