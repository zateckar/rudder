-- Converge the deployed databases onto the baseline.
--
-- Two differences were found by diffing a copy of a live control plane against
-- a database built from 0000. Both predate the baseline and neither can be
-- fixed by it, because `CREATE TABLE IF NOT EXISTS` does not touch a table that
-- already exists.
--
-- 1. `applications.auth_type` still defaults to 'none' in the database while
--    schema.ts has said 'global' for some time. This is the drift the old
--    src/lib/db/index.ts documented as fixed — and it was fixed, in the CREATE
--    TABLE statement, which no existing database ever ran again. It is not
--    cosmetic: drizzle omits a column from the INSERT when the caller does not
--    supply it and lets the database default apply, and two paths do not supply
--    it — creating an application from a template, and `kubectl apply`. Every
--    application made either of those ways was created with authentication off
--    while the schema promised the worker's global OIDC. Those two call sites
--    now pass it explicitly as well; this is the other half.
--
--    SQLite cannot alter a column default, so the table is rebuilt. Inside a
--    transaction — which is where drizzle runs migrations — `PRAGMA
--    foreign_keys` is a no-op, so `defer_foreign_keys` is what holds the four
--    tables referencing `applications` while the parent is briefly absent. It
--    resets itself at COMMIT, which is also when the deferred checks run: if
--    the copy below lost a row, this migration fails and rolls back rather than
--    leaving orphans behind.
--
-- 2. Two indexes exist on the deployed databases that no schema ever declared —
--    left behind by one of the hand-written files in the old drizzle/. They
--    duplicate the leading column of the composite indexes that replaced them,
--    on the two highest-volume tables in the system, so they cost writes and
--    earn nothing.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__new_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`worker_id` text,
	`name` text NOT NULL,
	`description` text,
	`domain` text,
	`type` text DEFAULT 'single' NOT NULL,
	`deployment_format` text DEFAULT 'compose' NOT NULL,
	`manifest` text,
	`environment` text,
	`volumes` text,
	`restart_policy` text DEFAULT 'always' NOT NULL,
	`exposed_ports` text,
	`appsec_disabled_rules` text,
	`rate_limit_avg` integer,
	`rate_limit_burst` integer,
	`auth_type` text DEFAULT 'global' NOT NULL,
	`auth_config` text,
	`oidc_id_token_header` text,
	`oidc_access_token_header` text,
	`replicas` integer DEFAULT 1 NOT NULL,
	`git_repo` text,
	`git_branch` text,
	`git_dockerfile` text,
	`healthcheck` text,
	`health_timeout_seconds` integer,
	`retain_previous_minutes` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_applications` (
	`id`, `team_id`, `worker_id`, `name`, `description`, `domain`, `type`,
	`deployment_format`, `manifest`, `environment`, `volumes`, `restart_policy`,
	`exposed_ports`, `appsec_disabled_rules`, `rate_limit_avg`, `rate_limit_burst`,
	`auth_type`, `auth_config`, `oidc_id_token_header`, `oidc_access_token_header`,
	`replicas`, `git_repo`, `git_branch`, `git_dockerfile`, `healthcheck`,
	`health_timeout_seconds`, `retain_previous_minutes`, `created_by`, `created_at`,
	`updated_at`
)
SELECT
	`id`, `team_id`, `worker_id`, `name`, `description`, `domain`, `type`,
	`deployment_format`, `manifest`, `environment`, `volumes`, `restart_policy`,
	`exposed_ports`, `appsec_disabled_rules`, `rate_limit_avg`, `rate_limit_burst`,
	`auth_type`, `auth_config`, `oidc_id_token_header`, `oidc_access_token_header`,
	`replicas`, `git_repo`, `git_branch`, `git_dockerfile`, `healthcheck`,
	`health_timeout_seconds`, `retain_previous_minutes`, `created_by`, `created_at`,
	`updated_at`
FROM `applications`;--> statement-breakpoint
DROP TABLE `applications`;--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `applications_domain_unique` ON `applications` (`domain`) WHERE domain IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_worker_idx` ON `applications` (`worker_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_team_idx` ON `applications` (`team_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `container_metrics_collected_at_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `worker_metrics_collected_at_idx`;
