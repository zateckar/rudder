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
 * Let a test stand up a plain-HTTP Podman stub.
 *
 * `getRestPodmanClient` fails closed without mTLS credentials, which is right in
 * production and makes a local stub server unusable — the alternative is a full
 * CA, server and client certificate per test. It has to be here rather than in
 * the test file that wants it, because `$lib/server/env` parses the environment
 * once at import time and the suite shares a module registry, so whichever file
 * imports it first decides the value for all of them.
 *
 * Nothing asserts the fail-closed path today. A test that wants to should build
 * its own client rather than expect this to be unset.
 */
process.env.ALLOW_INSECURE_PODMAN = 'true';

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
