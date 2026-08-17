import { plugin } from 'bun';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

/**
 * Point the whole suite at a throwaway database.
 *
 * `$lib/db` opens a SQLite file at import time and bootstraps an admin user, so
 * any test that transitively imports it — several do — reads and writes a real
 * database. Set here in `preload`, before anything imports it.
 *
 * Unconditional, deliberately. Bun loads `.env` automatically and this project's
 * `.env` sets DATABASE_URL to `./data/rudder.db`, so honouring an existing value
 * meant `bun test` quietly operated on the developer's own control plane —
 * which it did, until this line stopped it. A test run has no business reaching
 * a database it did not create.
 *
 * ADMIN_PASSWORD is left unset so the bootstrap is skipped; tests that need
 * users create their own.
 */
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'rudder-test-')), 'test.db');
process.env.NODE_ENV = 'production';
delete process.env.ADMIN_PASSWORD;

/**
 * `src/lib/server/provisioning/index.ts` inlines its shell assets with Vite's
 * `?raw` suffix, which only Vite understands. Without this, importing that
 * module under `bun test` fails to resolve before a single test runs — and it
 * holds the Traefik label and OIDC config generators, which is exactly the code
 * most worth testing.
 *
 * Resolves the suffixed specifier to a real path and loads it as a default
 * string export, matching Vite's behaviour.
 */
plugin({
  name: 'vite-raw-imports',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')),
      namespace: 'vite-raw',
    }));

    build.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({
      contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
      loader: 'js',
    }));
  },
});
