-- Baseline. The whole schema as of the squash, not the first of a series.
--
-- drizzle/ previously held twenty-eight hand-written files with two duplicate
-- numbers and a journal that stopped at the eighteenth, because db:generate
-- could not run (see drizzle.config.ts) — and nothing applied any of them: the
-- runtime built its own schema from CREATE/ALTER statements in
-- src/lib/db/index.ts. The two were separately maintained and had already
-- drifted on applications.auth_type. This replaces both.
--
-- Hand-edited in one respect: every CREATE carries IF NOT EXISTS, so this
-- applies to a fresh database and is a no-op on the deployed ones, which
-- already have this exact shape. That makes it safe to record as applied
-- without inspecting each control plane first. Migrations generated from here
-- on are ordinary diffs and must NOT be made idempotent — a migration that
-- silently does nothing is how the drift above started. src/lib/db/index.ts
-- verifies the columns after migrating and says so loudly if any are missing.
CREATE TABLE IF NOT EXISTS `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`threshold` real NOT NULL,
	`message` text NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `alert_events_created_idx` ON `alert_events` (created_at DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`metric` text NOT NULL,
	`operator` text DEFAULT 'gt' NOT NULL,
	`threshold` real NOT NULL,
	`duration` integer,
	`channel_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`team_id` text,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`team_id` text,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `application_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source_app_id` text,
	`team_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`type` text DEFAULT 'single' NOT NULL,
	`deployment_format` text DEFAULT 'compose' NOT NULL,
	`manifest` text,
	`environment` text,
	`volumes` text,
	`restart_policy` text DEFAULT 'always' NOT NULL,
	`exposed_ports` text,
	`appsec_disabled_rules` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_app_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `applications` (
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `applications_domain_unique` ON `applications` (`domain`) WHERE domain IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_worker_idx` ON `applications` (`worker_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_team_idx` ON `applications` (`team_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`team_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_created_idx` ON `audit_logs` (created_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_team_created_idx` ON `audit_logs` (`team_id`,created_at DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_config` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_account_name` text NOT NULL,
	`access_key` text NOT NULL,
	`container_name` text DEFAULT 'rudder-backups' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_backup_at` integer,
	`last_backup_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `container_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`container_id` text NOT NULL,
	`collected_at` integer NOT NULL,
	`cpu_percent` real,
	`mem_usage_bytes` integer,
	`mem_limit_bytes` integer,
	`mem_percent` real,
	`net_rx_bytes` integer,
	`net_tx_bytes` integer,
	`block_read_bytes` integer,
	`block_write_bytes` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `container_metrics_container_collected_idx` ON `container_metrics` (`container_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `containers` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`worker_id` text,
	`container_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text NOT NULL,
	`status` text NOT NULL,
	`ports` text,
	`exposed_port` integer,
	`domain` text,
	`router_name` text,
	`routes` text,
	`labels` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`deployment_id` text,
	`state` text DEFAULT 'active' NOT NULL,
	`spec_hash` text,
	`reap_attempts` integer DEFAULT 0 NOT NULL,
	`reap_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `containers_worker_idx` ON `containers` (`worker_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `containers_application_idx` ON `containers` (`application_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `containers_worker_state_idx` ON `containers` (`worker_id`,`state`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deploy_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_used_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deploy_webhooks_app_idx` ON `deploy_webhooks` (`application_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest` text,
	`environment` text,
	`volumes` text,
	`image` text,
	`image_digest` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`deployed_by` text,
	`error_message` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deployed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deployments_app_version_idx` ON `deployments` (`application_id`,version DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`team_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oidc_config` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`provider_name` text DEFAULT 'Generic OIDC' NOT NULL,
	`issuer_url` text,
	`client_id` text,
	`client_secret` text,
	`authorization_endpoint` text,
	`token_endpoint` text,
	`userinfo_endpoint` text,
	`jwks_uri` text,
	`scopes` text DEFAULT 'openid email profile',
	`use_pkce` integer DEFAULT true,
	`allow_registration` integer DEFAULT true,
	`team_claim_name` text,
	`team_claim_key` text,
	`team_role_suffix` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reconcile_reports` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL,
	`clean` integer DEFAULT true NOT NULL,
	`findings` text NOT NULL,
	`errors` text,
	`fingerprint` text,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'team' NOT NULL,
	`delivery_mode` text DEFAULT 'env' NOT NULL,
	`team_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `secrets_team_idx` ON `secrets` (`team_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `team_members_team_user_unique` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_quotas` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`max_cpu_cores` real,
	`max_memory_bytes` integer,
	`max_containers` integer,
	`max_applications` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `teams_name_unique` ON `teams` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `teams_slug_unique` ON `teams` (`slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_oidc` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`full_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`worker_id` text,
	`name` text NOT NULL,
	`container_path` text NOT NULL,
	`size_limit` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`collected_at` integer NOT NULL,
	`cpu_percent` real,
	`mem_usage_bytes` integer,
	`mem_limit_bytes` integer,
	`mem_percent` real,
	`disk_usage_bytes` integer,
	`disk_limit_bytes` integer,
	`disk_percent` real,
	`net_rx_bytes` integer,
	`net_tx_bytes` integer,
	`containers_running` integer,
	`containers_total` integer,
	`images_count` integer,
	`volumes_count` integer,
	`updates_pending` integer,
	`updates_security` integer,
	`reboot_required` integer,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_metrics_worker_collected_idx` ON `worker_metrics` (`worker_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_pings` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`pinged_at` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`error` text,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_pings_worker_pinged_idx` ON `worker_pings` (`worker_id`,`pinged_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hostname` text NOT NULL,
	`ssh_port` integer DEFAULT 22 NOT NULL,
	`ssh_user` text NOT NULL,
	`podman_api_url` text NOT NULL,
	`podman_ca_cert` text,
	`podman_client_cert` text,
	`podman_client_key` text,
	`base_domain` text,
	`crowdsec_bouncer_key` text,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`labels` text,
	`created_at` integer NOT NULL,
	`provisioned_at` integer,
	`last_seen_at` integer,
	`oidc_enabled` integer DEFAULT false NOT NULL,
	`oidc_provider_url` text,
	`oidc_client_id` text,
	`oidc_client_secret` text,
	`oidc_encryption_key` text,
	`oidc_callback_path` text,
	`oidc_applied_at` integer,
	`routing_mode` text DEFAULT 'labels' NOT NULL,
	`config_token` text,
	`config_basic_user` text,
	`config_basic_password` text,
	`config_fetched_at` integer,
	`config_fetch_status` integer,
	`config_fetch_detail` text,
	`config_fetch_attempt_at` integer
);
