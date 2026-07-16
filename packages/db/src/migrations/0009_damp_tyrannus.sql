CREATE TABLE `activity_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text DEFAULT 'github-atom-v1' NOT NULL,
	`activity_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`actor_github_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_change_source_activity_idx` ON `activity_change` (`source`,`activity_id`);--> statement-breakpoint
CREATE INDEX `activity_change_actor_seq_idx` ON `activity_change` (`actor_key`,`seq`);--> statement-breakpoint
CREATE TABLE `activity_retention_state` (
	`actor_key` text PRIMARY KEY NOT NULL,
	`compacted_through_seq` integer DEFAULT 0 NOT NULL,
	`retention_generation` integer DEFAULT 0 NOT NULL,
	`oldest_retained_published_at` integer,
	`oldest_retained_activity_id` text
);
--> statement-breakpoint
CREATE TABLE `activity_sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`head_seq` integer DEFAULT 0 NOT NULL,
	`retention_generation` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `activity_sync_state` (`id`, `head_seq`, `retention_generation`)
VALUES (1, 0, 0);--> statement-breakpoint
CREATE TRIGGER `activity_change_advance_head`
AFTER INSERT ON `activity_change`
BEGIN
	UPDATE `activity_sync_state`
	SET `head_seq` = max(`head_seq`, NEW.`seq`)
	WHERE `id` = 1;
END;--> statement-breakpoint
ALTER TABLE `feed_item` ADD `actor_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `feed_item` ADD `actor_github_id` text;--> statement-breakpoint
ALTER TABLE `feed_item` ADD `source` text DEFAULT 'github-atom-v1' NOT NULL;--> statement-breakpoint
UPDATE `feed_item`
SET
	`actor_github_id` = (
		SELECT `github_user`.`id`
		FROM `github_user`
		WHERE `github_user`.`login` = `feed_item`.`github_user_login`
	),
	`actor_key` = CASE
		WHEN (
			SELECT `github_user`.`id`
			FROM `github_user`
			WHERE `github_user`.`login` = `feed_item`.`github_user_login`
		) IS NOT NULL
		THEN 'github:' || (
			SELECT `github_user`.`id`
			FROM `github_user`
			WHERE `github_user`.`login` = `feed_item`.`github_user_login`
		)
		ELSE 'legacy-atom-login:' || lower(`github_user_login`)
	END
WHERE `actor_key` = '';--> statement-breakpoint
INSERT OR IGNORE INTO `activity_change` (
	`source`, `activity_id`, `actor_key`, `actor_github_id`, `created_at`
)
SELECT
	`source`, `id`, `actor_key`, `actor_github_id`, `created_at`
FROM `feed_item`
ORDER BY `created_at` ASC, `id` ASC;--> statement-breakpoint
INSERT OR IGNORE INTO `activity_retention_state` (
	`actor_key`,
	`compacted_through_seq`,
	`retention_generation`,
	`oldest_retained_published_at`,
	`oldest_retained_activity_id`
)
SELECT
	`actor_key`,
	0,
	0,
	min(`published_at`),
	(
		SELECT `oldest`.`id`
		FROM `feed_item` AS `oldest`
		WHERE `oldest`.`actor_key` = `feed_item`.`actor_key`
		ORDER BY `oldest`.`published_at` ASC, `oldest`.`id` ASC
		LIMIT 1
	)
FROM `feed_item`
GROUP BY `actor_key`;
--> statement-breakpoint
CREATE TRIGGER `local_feed_legacy_insert_compatibility`
AFTER INSERT ON `feed_item`
BEGIN
	UPDATE `feed_item`
	SET
		`actor_github_id` = (
			SELECT `github_user`.`id`
			FROM `github_user`
			WHERE `github_user`.`login` = NEW.`github_user_login`
		),
		`actor_key` = CASE
			WHEN (
				SELECT `github_user`.`id`
				FROM `github_user`
				WHERE `github_user`.`login` = NEW.`github_user_login`
			) IS NOT NULL
			THEN 'github:' || (
				SELECT `github_user`.`id`
				FROM `github_user`
				WHERE `github_user`.`login` = NEW.`github_user_login`
			)
			ELSE 'legacy-atom-login:' || lower(NEW.`github_user_login`)
		END
	WHERE `id` = NEW.`id`
		AND `actor_key` = '';

	INSERT OR IGNORE INTO `activity_change` (
		`source`, `activity_id`, `actor_key`, `actor_github_id`, `created_at`
	)
	SELECT
		`source`, `id`, `actor_key`, `actor_github_id`, `created_at`
	FROM `feed_item`
	WHERE `id` = NEW.`id`;

	INSERT INTO `activity_retention_state` (
		`actor_key`, `compacted_through_seq`, `retention_generation`,
		`oldest_retained_published_at`, `oldest_retained_activity_id`
	)
	SELECT `actor_key`, 0, 0, `published_at`, `id`
	FROM `feed_item`
	WHERE `id` = NEW.`id`
	ON CONFLICT (`actor_key`) DO UPDATE SET
		`oldest_retained_published_at` = excluded.`oldest_retained_published_at`,
		`oldest_retained_activity_id` = excluded.`oldest_retained_activity_id`
	WHERE `activity_retention_state`.`oldest_retained_published_at` IS NULL
		OR excluded.`oldest_retained_published_at`
			< `activity_retention_state`.`oldest_retained_published_at`
		OR (
			excluded.`oldest_retained_published_at`
				= `activity_retention_state`.`oldest_retained_published_at`
			AND excluded.`oldest_retained_activity_id`
				< `activity_retention_state`.`oldest_retained_activity_id`
		);
END;
--> statement-breakpoint
CREATE TRIGGER `local_feed_legacy_delete_compatibility`
BEFORE DELETE ON `feed_item`
WHEN EXISTS (
	SELECT 1
	FROM `activity_change`
	WHERE `source` = OLD.`source`
		AND `activity_id` = OLD.`id`
)
BEGIN
	INSERT INTO `activity_retention_state` (
		`actor_key`, `compacted_through_seq`, `retention_generation`,
		`oldest_retained_published_at`, `oldest_retained_activity_id`
	)
	VALUES (
		OLD.`actor_key`,
		coalesce((
			SELECT max(`seq`)
			FROM `activity_change`
			WHERE `source` = OLD.`source`
				AND `activity_id` = OLD.`id`
		), 0),
		1,
		(
			SELECT `published_at`
			FROM `feed_item`
			WHERE `actor_key` = OLD.`actor_key`
				AND `id` <> OLD.`id`
			ORDER BY `published_at` ASC, `id` ASC
			LIMIT 1
		),
		(
			SELECT `id`
			FROM `feed_item`
			WHERE `actor_key` = OLD.`actor_key`
				AND `id` <> OLD.`id`
			ORDER BY `published_at` ASC, `id` ASC
			LIMIT 1
		)
	)
	ON CONFLICT (`actor_key`) DO UPDATE SET
		`compacted_through_seq` = max(
			`activity_retention_state`.`compacted_through_seq`,
			excluded.`compacted_through_seq`
		),
		`retention_generation` = `activity_retention_state`.`retention_generation` + 1,
		`oldest_retained_published_at` = excluded.`oldest_retained_published_at`,
		`oldest_retained_activity_id` = excluded.`oldest_retained_activity_id`;

	DELETE FROM `activity_change`
	WHERE `source` = OLD.`source`
		AND `activity_id` = OLD.`id`;

	UPDATE `activity_sync_state`
	SET `retention_generation` = `retention_generation` + 1
	WHERE `id` = 1;
END;
