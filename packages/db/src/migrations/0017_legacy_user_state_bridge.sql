CREATE TRIGGER `legacy_user_filter_insert_bridge`
AFTER INSERT ON `user_filter`
WHEN NEW.`last_attempt_id` IS NULL
BEGIN
	INSERT INTO `user_state_change` (
		`user_id`, `entity_kind`, `entity_id`, `entity_version`, `changed_at`
	)
	VALUES (
		NEW.`user_id`, 'filter', NEW.`id`, NEW.`entity_version`, NEW.`updated_at`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_user_filter_update_bridge`
AFTER UPDATE OF `name`, `filter_rule`, `updated_at` ON `user_filter`
WHEN NEW.`last_attempt_id` IS OLD.`last_attempt_id`
	AND (
		NEW.`name` IS NOT OLD.`name`
		OR NEW.`filter_rule` IS NOT OLD.`filter_rule`
		OR NEW.`updated_at` IS NOT OLD.`updated_at`
	)
BEGIN
	UPDATE `user_filter`
	SET `entity_version` = OLD.`entity_version` + 1,
		`deleted_at` = NULL
	WHERE `id` = NEW.`id` AND `user_id` = NEW.`user_id`;

	INSERT INTO `user_state_change` (
		`user_id`, `entity_kind`, `entity_id`, `entity_version`, `changed_at`
	)
	SELECT
		NEW.`user_id`, 'filter', NEW.`id`, `entity_version`, NEW.`updated_at`
	FROM `user_filter`
	WHERE `id` = NEW.`id` AND `user_id` = NEW.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_user_filter_delete_bridge`
AFTER DELETE ON `user_filter`
WHEN OLD.`deleted_at` IS NULL
BEGIN
	INSERT INTO `user_filter` (
		`id`, `user_id`, `name`, `filter_rule`, `created_at`, `updated_at`,
		`entity_version`, `changed_revision`, `deleted_at`, `last_attempt_id`
	)
	VALUES (
		OLD.`id`, OLD.`user_id`, OLD.`name`, OLD.`filter_rule`, OLD.`created_at`,
		cast(unixepoch('subsecond') * 1000 as integer),
		OLD.`entity_version` + 1, 0,
		cast(unixepoch('subsecond') * 1000 as integer),
		'legacy-delete:' || lower(hex(randomblob(16)))
	);

	INSERT INTO `user_state_change` (
		`user_id`, `entity_kind`, `entity_id`, `entity_version`, `changed_at`
	)
	SELECT
		OLD.`user_id`, 'filter', OLD.`id`, `entity_version`, `updated_at`
	FROM `user_filter`
	WHERE `id` = OLD.`id` AND `user_id` = OLD.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_user_feed_state_insert_bridge`
AFTER INSERT ON `user_feed_state`
WHEN NEW.`last_attempt_id` IS NULL
BEGIN
	UPDATE `user_feed_state`
	SET `entity_version` = max(`entity_version`, 1)
	WHERE `user_id` = NEW.`user_id`;

	INSERT INTO `user_state_change` (
		`user_id`, `entity_kind`, `entity_id`, `entity_version`, `changed_at`
	)
	SELECT
		NEW.`user_id`, 'feed-state', 'feed', `entity_version`, NEW.`activity_cleared_at`
	FROM `user_feed_state`
	WHERE `user_id` = NEW.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_user_feed_state_prevent_regression`
BEFORE UPDATE OF `activity_cleared_at` ON `user_feed_state`
WHEN NEW.`last_attempt_id` IS OLD.`last_attempt_id`
	AND NEW.`activity_cleared_at` <= OLD.`activity_cleared_at`
BEGIN
	SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_user_feed_state_update_bridge`
AFTER UPDATE OF `activity_cleared_at` ON `user_feed_state`
WHEN NEW.`last_attempt_id` IS OLD.`last_attempt_id`
	AND NEW.`activity_cleared_at` > OLD.`activity_cleared_at`
BEGIN
	UPDATE `user_feed_state`
	SET `entity_version` = OLD.`entity_version` + 1
	WHERE `user_id` = NEW.`user_id`;

	INSERT INTO `user_state_change` (
		`user_id`, `entity_kind`, `entity_id`, `entity_version`, `changed_at`
	)
	SELECT
		NEW.`user_id`, 'feed-state', 'feed', `entity_version`, NEW.`activity_cleared_at`
	FROM `user_feed_state`
	WHERE `user_id` = NEW.`user_id`;
END;
