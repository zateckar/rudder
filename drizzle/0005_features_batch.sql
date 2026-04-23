-- Migration: Add tables for deployment history, notifications, alerts, webhooks, quotas, stacks, backups
-- Also adds new columns to applications table for stacks, replicas, git-based deploy, and healthchecks

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  version INTEGER NOT NULL,
  manifest TEXT,
  environment TEXT,
  volumes TEXT,
  image TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  deployed_by TEXT REFERENCES users(id),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  team_id TEXT REFERENCES teams(id),
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'gt',
  threshold REAL NOT NULL,
  duration INTEGER,
  channel_id TEXT REFERENCES notification_channels(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  team_id TEXT REFERENCES teams(id),
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY NOT NULL,
  rule_id TEXT REFERENCES alert_rules(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deploy_webhooks (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS team_quotas (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  max_cpu_cores REAL,
  max_memory_bytes INTEGER,
  max_containers INTEGER,
  max_applications INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  team_id TEXT REFERENCES teams(id),
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS backup_config (
  id TEXT PRIMARY KEY NOT NULL,
  storage_account_name TEXT NOT NULL,
  access_key TEXT NOT NULL,
  container_name TEXT NOT NULL DEFAULT 'rudder-backups',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_backup_at INTEGER,
  last_backup_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN stack_id TEXT REFERENCES stacks(id);
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN replicas INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN git_repo TEXT;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN git_branch TEXT;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN git_dockerfile TEXT;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN healthcheck TEXT;
