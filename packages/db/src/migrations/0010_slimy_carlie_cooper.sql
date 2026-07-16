CREATE TABLE `following_member` (
	`revision` text NOT NULL,
	`actor_key` text NOT NULL,
	`github_id` text NOT NULL,
	`login` text NOT NULL,
	`legacy_actor_keys` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`revision`, `actor_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `following_member_revision_position_idx` ON `following_member` (`revision`,`position`);--> statement-breakpoint
CREATE INDEX `following_member_revision_login_idx` ON `following_member` (`revision`,`login`);--> statement-breakpoint
CREATE TABLE `following_snapshot` (
	`revision` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `following_snapshot_user_completed_idx` ON `following_snapshot` (`user_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `following_sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_revision` text,
	`previous_revision` text,
	`completed_at` integer,
	`claim_token` text,
	`claim_claimed_at` integer
);
