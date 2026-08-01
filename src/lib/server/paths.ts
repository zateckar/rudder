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
