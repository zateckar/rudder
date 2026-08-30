import { defineConfig } from 'drizzle-kit';

/**
 * Configuration for `bun run db:generate`, which is the only thing that writes
 * to drizzle/. Migrations are *applied* at startup by src/lib/db/index.ts, not
 * by drizzle-kit — drizzle-kit is a devDependency and is not in the production
 * image.
 *
 * `driver` used to be set to 'bun-sqlite'. That is not one of the values
 * drizzle-kit accepts — the field is for turso, d1-http and expo — so every
 * invocation of db:generate failed its config validation before reading the
 * schema. Which is how drizzle/ came to be twenty-eight hand-written SQL files
 * with a journal that stopped at the eighteenth and two snapshots covering the
 * first two: nothing could regenerate them, so they were written by hand until
 * nobody trusted them and the runtime stopped consulting them at all. The
 * dialect alone is correct for a local SQLite file.
 */
export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/rudder.db',
  },
});
