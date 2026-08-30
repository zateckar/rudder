/**
 * Filesystem locations derived from configuration.
 *
 * Kept dependency-free so both the database layer and the environment loader
 * can import it without creating a cycle.
 */
import { dirname, isAbsolute, join } from 'path';

/** Absolute path to the SQLite database file. */
export function resolveDbPath(fallbackDir: string): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return join(fallbackDir, 'rudder.db');

  const withoutScheme = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  return isAbsolute(withoutScheme) ? withoutScheme : join(process.cwd(), withoutScheme);
}

/**
 * Directory holding the generated SQL migrations, applied at startup.
 *
 * `process.cwd()` rather than a path relative to this module: the production
 * bundle is rolled up into build/server/chunks with no stable relation to the
 * repository layout, while the working directory is the application root in
 * both places — the repository in development, /app in the image, which is
 * where the Dockerfile puts drizzle/.
 *
 * MIGRATIONS_DIR overrides it for anything that arranges its files differently.
 */
export function resolveMigrationsDir(): string {
  const raw = process.env.MIGRATIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(process.cwd(), 'drizzle');
}

/**
 * Directory holding persistent state: the database, generated secrets and the
 * SSH known_hosts file.  Follows DATABASE_URL so everything stays on the same
 * volume.
 */
export function resolveDataDir(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return join(process.cwd(), 'data');

  const withoutScheme = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  const abs = isAbsolute(withoutScheme) ? withoutScheme : join(process.cwd(), withoutScheme);
  return dirname(abs);
}
