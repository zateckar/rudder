import { plugin } from 'bun';
import { dirname, resolve } from 'path';

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
