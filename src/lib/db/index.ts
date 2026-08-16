import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveDbPath } from '../server/paths';

// DATABASE_URL is now honoured; it was previously documented but ignored, so
// the database always landed next to the bundle rather than where the operator
// asked for it.
const dbPath = resolveDbPath(
  join(dirname(fileURLToPath(import.meta.url)), '../../../data'),
);
const dbDir = dirname(dbPath);

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.run('PRAGMA journal_mode = WAL');
sqlite.run('PRAGMA foreign_keys = ON');

// ── Core tables (idempotent) ─────────────────────────────────────────────────
//
// This block, together with the ALTER TABLE migrations further down, is the
// authoritative schema at runtime: nothing calls drizzle's migrate(), so the
// files in drizzle/ are reference output from `bun run db:generate` only.
//
// When you change src/lib/db/schema.ts you MUST mirror it here — the two
// drifted before (applications.auth_type defaulted to 'none' here but 'global'
// in schema.ts, so new rows were created less protected than intended).
sqlite.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS teams_name_unique ON teams (name);
  CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_unique ON teams (slug);

  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL,
    podman_api_url TEXT NOT NULL,
    podman_ca_cert TEXT,
    podman_client_cert TEXT,
    podman_client_key TEXT,
    base_domain TEXT,
    crowdsec_bouncer_key TEXT,
    status TEXT NOT NULL DEFAULT 'provisioning',
    labels TEXT,
    created_at INTEGER NOT NULL,
    provisioned_at INTEGER,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT REFERENCES teams(id),
    worker_id TEXT REFERENCES workers(id),
    name TEXT NOT NULL,
    description TEXT,
    domain TEXT,
    type TEXT NOT NULL DEFAULT 'single',
    deployment_format TEXT NOT NULL DEFAULT 'compose',
    manifest TEXT,
    environment TEXT,
    volumes TEXT,
    restart_policy TEXT NOT NULL DEFAULT 'always',
    rate_limit_avg INTEGER,
    rate_limit_burst INTEGER,
    auth_type TEXT NOT NULL DEFAULT 'global',
    auth_config TEXT,
    stack_id TEXT,
    replicas INTEGER NOT NULL DEFAULT 1,
    git_repo TEXT,
    git_branch TEXT,
    git_dockerfile TEXT,
    healthcheck TEXT,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT REFERENCES applications(id),
    worker_id TEXT REFERENCES workers(id),
    container_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    ports TEXT,
    exposed_port INTEGER,
    labels TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS volumes (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT REFERENCES teams(id),
    worker_id TEXT REFERENCES workers(id),
    name TEXT NOT NULL,
    container_path TEXT NOT NULL,
    size_limit INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    team_id TEXT REFERENCES teams(id),
    expires_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT REFERENCES users(id),
    team_id TEXT REFERENCES teams(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_oidc (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    last_synced_at INTEGER
  );
`);

// ── Additional tables added over time (idempotent) ───────────────────────────
sqlite.run(`
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
  CREATE INDEX IF NOT EXISTS container_metrics_container_collected_idx
    ON container_metrics (container_id, collected_at);
  DROP INDEX IF EXISTS container_metrics_container_id_idx;

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

// Enforce one membership per (team, user).  Duplicates were previously
// possible, making role checks depend on which row happened to come back
// first, so collapse any that exist before adding the constraint.
try {
  sqlite.run(`
    DELETE FROM team_members
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM team_members GROUP BY team_id, user_id
    );
  `);
  sqlite.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_user_unique
      ON team_members (team_id, user_id);
  `);
} catch (e) {
  console.error('[db] Could not enforce unique team memberships:', e);
}

// Enforce one application per hostname.  Traefik routes by Host, so two
// applications claiming the same domain produce two routers with an identical
// rule and requests land on whichever Traefik happens to pick.  The index is
// partial because `domain` is nullable (workers without a base domain).
// It is best-effort: if pre-existing rows already collide the CREATE fails and
// the application-level checks in $lib/server/domains still apply.
try {
  sqlite.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS applications_domain_unique
      ON applications (domain) WHERE domain IS NOT NULL;
  `);
} catch (e) {
  console.error(
    '[db] Could not enforce unique application domains — resolve duplicate ' +
    'applications.domain values and restart:', e
  );
}

// Add description column to applications if it doesn't exist
try {
  sqlite.run(`ALTER TABLE applications ADD COLUMN description TEXT;`);
} catch {
  // Column already exists
}

// Add crowdsec_bouncer_key column to workers if it doesn't exist
try {
  sqlite.run(`ALTER TABLE workers ADD COLUMN crowdsec_bouncer_key TEXT;`);
} catch {
  // Column already exists
}

// Add OIDC columns to workers if they don't exist
for (const col of [
  `ALTER TABLE workers ADD COLUMN oidc_enabled INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE workers ADD COLUMN oidc_provider_url TEXT;`,
  `ALTER TABLE workers ADD COLUMN oidc_client_id TEXT;`,
  `ALTER TABLE workers ADD COLUMN oidc_client_secret TEXT;`,
  `ALTER TABLE workers ADD COLUMN oidc_encryption_key TEXT;`,
  `ALTER TABLE workers ADD COLUMN oidc_applied_at INTEGER;`,
  `ALTER TABLE workers ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'labels';`,
  `ALTER TABLE workers ADD COLUMN config_token TEXT;`,
  `ALTER TABLE workers ADD COLUMN config_fetched_at INTEGER;`,
  `ALTER TABLE containers ADD COLUMN domain TEXT;`,
  `ALTER TABLE containers ADD COLUMN router_name TEXT;`,
]) {
  try { sqlite.run(col); } catch { /* Column already exists */ }
}

// Add team claim columns to oidc_config if they don't exist
try {
  sqlite.run(`ALTER TABLE oidc_config ADD COLUMN team_claim_name TEXT;`);
} catch {
  // Column already exists
}
try {
  sqlite.run(`ALTER TABLE oidc_config ADD COLUMN team_claim_key TEXT;`);
} catch {
  // Column already exists
}

// Add per-application rate limiting and auth columns
try {
  sqlite.run(`ALTER TABLE applications ADD COLUMN rate_limit_avg INTEGER;`);
} catch {
  // Column already exists
}
try {
  sqlite.run(`ALTER TABLE applications ADD COLUMN rate_limit_burst INTEGER;`);
} catch {
  // Column already exists
}
try {
  sqlite.run(`ALTER TABLE applications ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';`);
} catch {
  // Column already exists
}
try {
  sqlite.run(`ALTER TABLE applications ADD COLUMN auth_config TEXT;`);
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
  try { sqlite.run(col); } catch { /* Column already exists */ }
}

// Create new feature tables
sqlite.run(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL REFERENCES applications(id),
    version INTEGER NOT NULL,
    manifest TEXT, environment TEXT, volumes TEXT, image TEXT,
    image_digest TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    deployed_by TEXT REFERENCES users(id),
    error_message TEXT,
    created_at INTEGER NOT NULL, finished_at INTEGER
  );
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    team_id TEXT REFERENCES teams(id),
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.run(`
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

sqlite.run(`
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

sqlite.run(`
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

sqlite.run(`
  CREATE TABLE IF NOT EXISTS team_quotas (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id),
    max_cpu_cores REAL, max_memory_bytes INTEGER,
    max_containers INTEGER, max_applications INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS stacks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL, description TEXT,
    team_id TEXT REFERENCES teams(id),
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

sqlite.run(`
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
sqlite.run(`
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
    volumes_count INTEGER,
    updates_pending INTEGER,
    updates_security INTEGER,
    reboot_required INTEGER
  );

  CREATE INDEX IF NOT EXISTS worker_metrics_worker_collected_idx
    ON worker_metrics (worker_id, collected_at);
  DROP INDEX IF EXISTS worker_metrics_worker_id_idx;

  CREATE TABLE IF NOT EXISTS worker_pings (
    id TEXT PRIMARY KEY NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    pinged_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS worker_pings_worker_pinged_idx
    ON worker_pings (worker_id, pinged_at);
  DROP INDEX IF EXISTS worker_pings_worker_id_idx;

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
    delivery_mode TEXT NOT NULL DEFAULT 'env',
    team_id TEXT REFERENCES teams(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Columns added to tables that already existed on deployed control planes.
// These run *after* the CREATE TABLE block above — an ALTER against a table
// that has not been created yet fails silently here and would then be missed
// entirely, because CREATE TABLE IF NOT EXISTS makes the new column only on a
// database that never had the table.
for (const col of [
  `ALTER TABLE deployments ADD COLUMN image_digest TEXT;`,
  `ALTER TABLE worker_metrics ADD COLUMN updates_pending INTEGER;`,
  `ALTER TABLE worker_metrics ADD COLUMN updates_security INTEGER;`,
  `ALTER TABLE worker_metrics ADD COLUMN reboot_required INTEGER;`,
  `ALTER TABLE secrets ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'env';`,
]) {
  try { sqlite.run(col); } catch { /* Column already exists */ }
}

const db = drizzle(sqlite);

export { db, sqlite };

// ── Auto-bootstrap admin user ─────────────────────────────────────────────────
// Creates the admin user on first boot — no manual db:init required.
//
//   Production: set ADMIN_PASSWORD (required; app skips creation if not set)
//   Development: defaults to password "admin" so the app is usable immediately
{
  const isProduction = process.env.NODE_ENV === 'production';
  const password = process.env.ADMIN_PASSWORD ?? (isProduction ? null : 'admin');

  if (password) {
    const existingAdmin = sqlite
      .query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
      .get() as { id: string } | null;

    if (!existingAdmin) {
      const hashed = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
      const now = Math.floor(Date.now() / 1000); // Unix seconds (Drizzle timestamp mode)
      sqlite.run(
        `INSERT INTO users (id, username, email, password_hash, full_name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), 'admin', 'admin@localhost', hashed, 'Administrator', 'admin', now, now]
      );
      if (isProduction) {
        console.log('[db] Admin user "admin" created from ADMIN_PASSWORD.');
      } else {
        console.warn('[db] Created default admin user (username: admin, password: admin). Set ADMIN_PASSWORD for production.');
      }
    }
  } else {
    console.warn('[db] ADMIN_PASSWORD not set — skipping admin user creation. Set it to auto-create the admin account.');
  }
}


// ── Safe column subsets & runtime helpers (sensitive fields excluded) ────────
// These must be used in every page load() that returns data to the browser.
import { getTableColumns } from 'drizzle-orm';
import { workers as _workersTable, users as _usersTable } from './schema';

/**
 * Worker columns safe to serialise to the browser.
 * Excludes: podmanCaCert, podmanClientCert, podmanClientKey,
 *           crowdsecBouncerKey, oidcClientSecret, oidcEncryptionKey, configToken.
 *
 * routingMode and configFetchedAt are deliberately included — the worker page
 * shows both.
 */
export const safeWorkerColumns = (() => {
  const {
    podmanCaCert: _a, podmanClientCert: _b, podmanClientKey: _c,
    crowdsecBouncerKey: _d, oidcClientSecret: _e, oidcEncryptionKey: _f,
    configToken: _g,
    ...cols
  } = getTableColumns(_workersTable);
  return cols;
})();

/**
 * User columns safe to serialise to the browser.
 * Excludes: passwordHash.
 */
export const safeUserColumns = (() => {
  const { passwordHash: _, ...cols } = getTableColumns(_usersTable);
  return cols;
})();