import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '../../../data');
const dbPath = join(dbDir, 'rudder.db');

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Ensure new tables exist (idempotent — safe to run on every startup)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS container_metrics (
    id TEXT PRIMARY KEY NOT NULL,
    container_id TEXT NOT NULL,
    collected_at INTEGER NOT NULL,
    cpu_percent REAL,
    mem_usage_bytes INTEGER,
    mem_limit_bytes INTEGER,
    mem_percent REAL,
    net_rx_bytes INTEGER,
    net_tx_bytes INTEGER,
    block_read_bytes INTEGER,
    block_write_bytes INTEGER
  );
  CREATE INDEX IF NOT EXISTS container_metrics_container_id_idx
    ON container_metrics (container_id);
  CREATE INDEX IF NOT EXISTS container_metrics_collected_at_idx
    ON container_metrics (collected_at);

  CREATE TABLE IF NOT EXISTS oidc_config (
    id TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    provider_name TEXT NOT NULL DEFAULT 'Generic OIDC',
    issuer_url TEXT,
    client_id TEXT,
    client_secret TEXT,
    authorization_endpoint TEXT,
    token_endpoint TEXT,
    userinfo_endpoint TEXT,
    jwks_uri TEXT,
    scopes TEXT DEFAULT 'openid email profile',
    use_pkce INTEGER DEFAULT 1,
    allow_registration INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Add description column to applications if it doesn't exist
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN description TEXT;`);
} catch {
  // Column already exists
}

// Add crowdsec_bouncer_key column to workers if it doesn't exist
try {
  sqlite.exec(`ALTER TABLE workers ADD COLUMN crowdsec_bouncer_key TEXT;`);
} catch {
  // Column already exists
}

// Add team claim columns to oidc_config if they don't exist
try {
  sqlite.exec(`ALTER TABLE oidc_config ADD COLUMN team_claim_name TEXT;`);
} catch {
  // Column already exists
}
try {
  sqlite.exec(`ALTER TABLE oidc_config ADD COLUMN team_claim_key TEXT;`);
} catch {
  // Column already exists
}

// Add per-application rate limiting and auth columns
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN rate_limit_avg INTEGER;`);
} catch {
  // Column already exists
}
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN rate_limit_burst INTEGER;`);
} catch {
  // Column already exists
}
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';`);
} catch {
  // Column already exists
}
try {
  sqlite.exec(`ALTER TABLE applications ADD COLUMN auth_config TEXT;`);
} catch {
  // Column already exists
}

// Add stack, replicas, git, and healthcheck columns to applications
for (const col of [
  `ALTER TABLE applications ADD COLUMN stack_id TEXT;`,
  `ALTER TABLE applications ADD COLUMN replicas INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE applications ADD COLUMN git_repo TEXT;`,
  `ALTER TABLE applications ADD COLUMN git_branch TEXT;`,
  `ALTER TABLE applications ADD COLUMN git_dockerfile TEXT;`,
  `ALTER TABLE applications ADD COLUMN healthcheck TEXT;`,
]) {
  try { sqlite.exec(col); } catch { /* Column already exists */ }
}

// Create new feature tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES applications(id),
    version INTEGER NOT NULL,
    manifest TEXT, environment TEXT, volumes TEXT, image TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    deployed_by TEXT REFERENCES users(id),
    error_message TEXT,
    created_at INTEGER NOT NULL, finished_at INTEGER
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    team_id TEXT REFERENCES teams(id),
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
    metric TEXT NOT NULL, operator TEXT NOT NULL DEFAULT 'gt',
    threshold REAL NOT NULL, duration INTEGER,
    channel_id TEXT REFERENCES notification_channels(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    team_id TEXT REFERENCES teams(id),
    last_triggered_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS alert_events (
    id TEXT PRIMARY KEY NOT NULL,
    rule_id TEXT REFERENCES alert_rules(id),
    resource_type TEXT NOT NULL, resource_id TEXT,
    metric TEXT NOT NULL, value REAL NOT NULL, threshold REAL NOT NULL,
    message TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS deploy_webhooks (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES applications(id),
    token TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS team_quotas (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id),
    max_cpu_cores REAL, max_memory_bytes INTEGER,
    max_containers INTEGER, max_applications INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS stacks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL, description TEXT,
    team_id TEXT REFERENCES teams(id),
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS backup_config (
    id TEXT PRIMARY KEY NOT NULL,
    storage_account_name TEXT NOT NULL,
    access_key TEXT NOT NULL,
    container_name TEXT NOT NULL DEFAULT 'rudder-backups',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_backup_at INTEGER, last_backup_status TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

// Application templates table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS application_templates (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    source_app_id TEXT REFERENCES applications(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    shared INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'single',
    deployment_format TEXT NOT NULL DEFAULT 'compose',
    manifest TEXT,
    environment TEXT,
    volumes TEXT,
    restart_policy TEXT NOT NULL DEFAULT 'always',
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS worker_metrics (
    id TEXT PRIMARY KEY NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    collected_at INTEGER NOT NULL,
    cpu_percent REAL,
    mem_usage_bytes INTEGER,
    mem_limit_bytes INTEGER,
    mem_percent REAL,
    disk_usage_bytes INTEGER,
    disk_limit_bytes INTEGER,
    disk_percent REAL,
    net_rx_bytes INTEGER,
    net_tx_bytes INTEGER,
    containers_running INTEGER,
    containers_total INTEGER,
    images_count INTEGER,
    volumes_count INTEGER
  );

  CREATE INDEX IF NOT EXISTS worker_metrics_worker_id_idx
    ON worker_metrics (worker_id);
  CREATE INDEX IF NOT EXISTS worker_metrics_collected_at_idx
    ON worker_metrics (collected_at);

  CREATE TABLE IF NOT EXISTS worker_pings (
    id TEXT PRIMARY KEY NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    pinged_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS worker_pings_worker_id_idx
    ON worker_pings (worker_id);

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    scope TEXT NOT NULL DEFAULT 'team',
    team_id TEXT REFERENCES teams(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export const db = drizzle(sqlite);
export type Db = DB;
