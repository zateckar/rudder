import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { resolveDbPath, resolveMigrationsDir } from '../server/paths';
import * as schema from './schema';

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

// `PRAGMA foreign_keys` is deliberately not set yet. SQLite's default is off,
// and off is the state its own documentation requires for the rebuild-and-
// rename that a column change needs — a table cannot be dropped and recreated
// while its children's references are being enforced. It has to be off *here*
// rather than inside the migration because the pragma is a no-op within a
// transaction, and drizzle wraps every migration in one. `defer_foreign_keys`
// is not a substitute: dropping the parent counts every child row as a
// violation, and renaming the replacement into place does not clear the
// counter, so the commit fails.
//
// It goes on immediately after migrating, and `PRAGMA foreign_key_check` runs
// in between so nothing a migration broke passes unnoticed.
const db = drizzle(sqlite, { schema });

// ── Schema ───────────────────────────────────────────────────────────────────
//
// src/lib/db/schema.ts is the schema. `bun run db:generate` turns it into SQL
// in drizzle/, and this applies that SQL. One definition, one generator, one
// place it is applied.
//
// It used not to be. This file held twenty-seven CREATE TABLE blocks and
// fifty-six `try { ALTER TABLE } catch {}` statements and *was* the runtime
// schema; drizzle/ held twenty-eight hand-written files that nothing applied,
// were not in the image, and could not be regenerated because db:generate had
// been failing its own config validation for as long as it had existed. Adding
// a column meant editing three places and the schema was whatever the union of
// them happened to produce. They had already diverged where it mattered:
// `applications.auth_type` defaulted to 'none' here and 'global' in schema.ts,
// so every application created through the path that used the database default
// was less protected than the one the schema promised.
//
// The failure this cannot prevent is a column that the baseline's IF NOT EXISTS
// skipped on an existing database — see `verifySchema` below, which is why the
// silence is over.
try {
  migrate(db, { migrationsFolder: resolveMigrationsDir() });
} catch (e) {
  // Fatal, unlike most startup work here. Every query in the application is
  // written against schema.ts; if the database could not be brought to it there
  // is nothing to serve, and starting anyway would turn one legible error into
  // a hundred illegible ones spread over the next hour.
  console.error(
    `[db] Could not apply migrations from ${resolveMigrationsDir()}. The control plane ` +
      `cannot start against a schema it does not know the shape of.`,
    e,
  );
  throw e;
}

/**
 * Report rows whose foreign key points at something that is not there.
 *
 * Runs while enforcement is still off, which is the only moment it can see the
 * whole database rather than only what is written from now on. Two things show
 * up here: a migration that broke a reference — the reason this runs at all —
 * and rows that were already orphaned before enforcement was ever switched on,
 * which nothing has looked for until now.
 *
 * Reported, not deleted. Every one of these is a row somebody's application
 * once depended on, and guessing which are safe to remove is not a startup
 * decision.
 */
{
  try {
    const violations = sqlite.query('PRAGMA foreign_key_check').all() as Array<{
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }>;

    if (violations.length > 0) {
      const byTable = new Map<string, number>();
      for (const v of violations) {
        const key = `${v.table} → ${v.parent}`;
        byTable.set(key, (byTable.get(key) ?? 0) + 1);
      }
      console.error(
        `[db] ${violations.length} row(s) reference something that does not exist:\n  ` +
          [...byTable].map(([k, n]) => `${n} in ${k}`).join('\n  '),
      );
    }
  } catch (e) {
    console.error('[db] Could not check foreign keys:', e);
  }
}

sqlite.run('PRAGMA foreign_keys = ON');

/**
 * Check that every column schema.ts declares actually exists.
 *
 * The baseline migration is deliberately idempotent so it can adopt the
 * databases that were built by the old startup DDL rather than by it. The cost
 * of that is exactly one blind spot: on a database that already had the tables,
 * `CREATE TABLE IF NOT EXISTS` will not add a column that is missing from one
 * of them, and nothing would say so — the queries would simply fail later, one
 * feature at a time, with an error naming the column and not the cause.
 *
 * So it is checked, once, at startup. Reports rather than repairs: an automatic
 * ALTER here would be the beginning of the second schema authority all of this
 * exists to remove. The message carries the statement to run.
 */
function verifySchema(): void {
  const missing: string[] = [];

  for (const value of Object.values(schema)) {
    // schema.ts exports relations and types alongside the tables.
    if (!is(value, SQLiteTable)) continue;

    const table = getTableName(value);
    // Interpolated because PRAGMA takes no bound parameters. The name comes
    // from this module's own table definitions, never from a request.
    const present = new Set(
      (sqlite.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );

    if (present.size === 0) {
      missing.push(`table "${table}" does not exist`);
      continue;
    }

    for (const column of Object.values(getTableColumns(value))) {
      if (!present.has(column.name)) missing.push(`"${table}"."${column.name}"`);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[db] The database is missing ${missing.length} thing(s) that src/lib/db/schema.ts ` +
        `declares:\n  ${missing.join('\n  ')}\n` +
        `This database predates the migration baseline and was not brought fully up to date ` +
        `before it. Add them by hand and restart; the baseline's IF NOT EXISTS cannot.`,
    );
  }
}

try {
  verifySchema();
} catch (e) {
  // A check, not a dependency. It must never be the reason the panel is down.
  console.error('[db] Could not verify the schema:', e);
}

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
      // Branches on where the password came from, not on the environment. It
      // used to branch on `isProduction`, so a developer who had set
      // ADMIN_PASSWORD was told the account's password was "admin" — the one
      // thing on this line they might act on, and wrong.
      if (process.env.ADMIN_PASSWORD) {
        console.log('[db] Admin user "admin" created with the password from ADMIN_PASSWORD.');
      } else {
        console.warn('[db] Created default admin user (username: admin, password: admin). Set ADMIN_PASSWORD for production.');
      }
    }
  } else {
    console.warn('[db] ADMIN_PASSWORD not set — skipping admin user creation. Set it to auto-create the admin account.');
  }
}

// ── Backfill: encrypt applications.auth_config ───────────────────────────────
//
// The column holds a per-application OIDC client secret and the 32-character
// session key the Traefik plugin uses as an AES-256 key, and was stored as
// plain text while every other credential in the database went through
// `encryptField`.
//
// Readers use `decryptField`, which passes plaintext through, so this is not
// required for correctness — it is required for the column to actually be
// encrypted at rest without waiting for someone to re-save each application.
// Idempotent: `isEncrypted` skips rows that are already ciphertext, so this is
// a no-op on every boot after the first.
{
  try {
    const rows = sqlite
      .query("SELECT id, auth_config FROM applications WHERE auth_config IS NOT NULL AND auth_config != ''")
      .all() as Array<{ id: string; auth_config: string }>;

    if (rows.length > 0) {
      const { encryptField, isEncrypted } = await import('../server/encryption');
      const stale = rows.filter((r) => !isEncrypted(r.auth_config));

      for (const row of stale) {
        sqlite.run('UPDATE applications SET auth_config = ? WHERE id = ?', [
          encryptField(row.auth_config),
          row.id,
        ]);
      }
      if (stale.length > 0) {
        console.log(`[db] Encrypted auth_config for ${stale.length} application(s).`);
      }
    }
  } catch (e) {
    // Never fatal: the readers tolerate plaintext, so a failure here degrades to
    // the previous behaviour rather than preventing startup.
    console.error('[db] Could not backfill encrypted auth_config:', e);
  }
}


// ── Safe column subsets & runtime helpers (sensitive fields excluded) ────────
// These must be used in every page load() that returns data to the browser.
import {
  workers as _workersTable,
  users as _usersTable,
  applications as _applicationsTable,
} from './schema';

/**
 * Worker columns safe to serialise to the browser.
 * Excludes: podmanCaCert, podmanClientCert, podmanClientKey,
 *           crowdsecBouncerKey, oidcClientSecret, oidcEncryptionKey,
 *           configToken, configBasicPassword.
 *
 * routingMode and configFetchedAt are deliberately included — the worker page
 * shows both. So is `configBasicUser`: a username is not a credential and the
 * settings form has to show which one is configured. Only the password leaves.
 */
export const safeWorkerColumns = (() => {
  const {
    podmanCaCert: _a, podmanClientCert: _b, podmanClientKey: _c,
    crowdsecBouncerKey: _d, oidcClientSecret: _e, oidcEncryptionKey: _f,
    configToken: _g, configBasicPassword: _h,
    ...cols
  } = getTableColumns(_workersTable);
  return cols;
})();

/** A worker row reduced to `safeWorkerColumns`. */
export type SafeWorker = Omit<
  typeof _workersTable.$inferSelect,
  'podmanCaCert' | 'podmanClientCert' | 'podmanClientKey'
  | 'crowdsecBouncerKey' | 'oidcClientSecret' | 'oidcEncryptionKey'
  | 'configToken' | 'configBasicPassword'
>;

/**
 * Strip a worker row already in hand down to what a browser may see.
 *
 * `safeWorkerColumns` covers the case where the row is being selected. This
 * covers the case where it is not — a helper that loaded full rows for its own
 * server-side reasons and now wants to return part of them to a page.
 *
 * Driven off the same list rather than another hand-written destructure. There
 * were three of those, and they had already drifted: the copy on the
 * new-application page never learned about `configBasicPassword`, so it
 * published one the moment that column existed.
 */
export function toSafeWorker(worker: typeof _workersTable.$inferSelect): SafeWorker {
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(safeWorkerColumns)) {
    safe[key] = (worker as Record<string, unknown>)[key];
  }
  return safe as SafeWorker;
}

/**
 * User columns safe to serialise to the browser.
 * Excludes: passwordHash.
 */
export const safeUserColumns = (() => {
  const { passwordHash: _, ...cols } = getTableColumns(_usersTable);
  return cols;
})();

/**
 * Application columns safe to put in a *list* payload.
 *
 * Excludes three columns that no list or dashboard renders and that should not
 * be broadcast to every member of a team:
 *
 * - `authConfig` — holds the per-application OIDC `clientSecret` and the
 *   32-character `sessionEncryptionKey` the Traefik plugin uses as an AES key.
 *   The edit form legitimately reads it back to prefill itself, and does so with
 *   a full `select()`; a list has no such need.
 * - `manifest` — up to 100,000 characters per application (see
 *   `schemas.createApplication`), rendered by nothing on a list page, and
 *   serialised into the SSR payload of the page users land on most.
 * - `environment` — the application's own environment block, same reasoning.
 *
 * Detail and edit pages keep using a full `select()`; they show these fields.
 */
export const safeApplicationColumns = (() => {
  const {
    authConfig: _a, manifest: _b, environment: _c,
    ...cols
  } = getTableColumns(_applicationsTable);
  return cols;
})();
