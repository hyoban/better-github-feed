CREATE TABLE `user_mutation_receipt` (
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `attempt_id`)
);
--> statement-breakpoint
CREATE INDEX `user_mutation_receipt_user_mutation_idx` ON `user_mutation_receipt` (`user_id`,`mutation_id`);--> statement-breakpoint
CREATE TABLE `user_state_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_version` integer NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_state_change_user_seq_idx` ON `user_state_change` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `user_state_sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`head_seq` integer DEFAULT 0 NOT NULL,
	`compacted_through_seq` integer DEFAULT 0 NOT NULL,
	`epoch` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `user_feed_state` ADD `entity_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_feed_state` ADD `changed_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_feed_state` ADD `last_attempt_id` text;--> statement-breakpoint
ALTER TABLE `user_filter` ADD `entity_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_filter` ADD `changed_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_filter` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `user_filter` ADD `last_attempt_id` text;--> statement-breakpoint
CREATE TRIGGER `user_state_change_advance_head`
AFTER INSERT ON `user_state_change`
BEGIN
	INSERT INTO `user_state_sync_state` (
		`user_id`, `head_seq`, `compacted_through_seq`, `epoch`
	)
	VALUES (NEW.`user_id`, NEW.`seq`, 0, 'legacy-v1')
	ON CONFLICT (`user_id`) DO UPDATE
	SET `head_seq` = max(`head_seq`, NEW.`seq`);

	UPDATE `user_filter`
	SET `changed_revision` = NEW.`seq`
	WHERE NEW.`entity_kind` = 'filter'
		AND `user_id` = NEW.`user_id`
		AND `id` = NEW.`entity_id`;

	UPDATE `user_feed_state`
	SET `changed_revision` = NEW.`seq`
	WHERE NEW.`entity_kind` = 'feed-state'
		AND `user_id` = NEW.`user_id`;
END;
