/**
 * Routing configuration generated from the database.
 *
 * Workers in `http` routing mode fetch this document and drop it into
 * `/etc/traefik/dynamic/routes.yml`, where Traefik's file provider picks it up.
 * The alternative — `labels` mode — stamps the same routing into container
 * labels at creation time, which is why changing a rate limit or an auth mode
 * used to need a redeploy.
 *
 * The correctness argument for the migration is equivalence: rather than
 * writing a second generator that must be kept in step with
 * `generateTraefikLabelsForApp`, this module calls that same function and
 * translates its output. `labelsToDynamicConfig` is the Traefik docker
 * provider's transformation, done here instead of there. A test runs both over
 * one fixture and compares.
 */
import { generateTraefikLabelsForApp, renderGlobalOidcConfig, type AppMiddlewareOptions } from './provisioning';
import { normalizeOidcSecret } from './oidc';

export interface DynamicConfig {
  http: {
    routers: Record<string, any>;
    services: Record<string, any>;
    middlewares: Record<string, any>;
  };
}

/** What actually goes over the wire — empty sections are omitted. See below. */
export interface ServedConfig {
  http: {
    routers?: Record<string, any>;
    services?: Record<string, any>;
    middlewares?: Record<string, any>;
  };
}

/**
 * Drop sections with nothing in them.
 *
 * Traefik's file provider rejects an empty section outright — a document
 * carrying `"middlewares": {}` fails to load with *"middlewares cannot be a
 * standalone element"*, and the failure is per-file, so one empty map discards
 * every router in the document. An application with no rate limit and no
 * per-app OIDC produces exactly that. Verified against Traefik 3.7.10: the same
 * document without the empty key loads fine.
 */
export function pruneEmptySections(config: DynamicConfig): ServedConfig {
  const http: ServedConfig['http'] = {};
  for (const section of ['routers', 'services', 'middlewares'] as const) {
    const value = config.http[section];
    if (value && Object.keys(value).length > 0) http[section] = value;
  }
  return { http };
}

/**
 * Traefik's file provider expects camelCase where the label vocabulary is all
 * lowercase. Only our own generated keys appear here — user-supplied `traefik.*`
 * labels are stripped long before this point.
 */
const RENAMES: Record<string, string> = {
  loadbalancer: 'loadBalancer',
  healthcheck: 'healthCheck',
  certresolver: 'certResolver',
  entrypoints: 'entryPoints',
  ratelimit: 'rateLimit',
  passhostheader: 'passHostHeader',
};

/** Leaves Traefik unmarshals into an integer. Everything else stays a string. */
const NUMERIC_LEAVES = new Set(['average', 'burst']);

/** Values that are lists in the file provider but comma-joined in a label. */
const LIST_LEAVES = new Set(['entryPoints', 'middlewares']);

function setPath(root: any, path: string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    // `routers.x.tls` arrives as the string "true" and then again as the parent
    // of `certResolver`. Whichever order they land in, the object wins.
    if (node[key] === undefined || typeof node[key] !== 'object' || node[key] === null) {
      node[key] = {};
    }
    node = node[key];
  }
  const leaf = path[path.length - 1];
  if (typeof node[leaf] === 'object' && node[leaf] !== null) return; // don't clobber `tls: {}`
  node[leaf] = value;
}

/**
 * Convert the flat `traefik.*` label map into the nested document the file
 * provider consumes.
 *
 * Middleware references are rewritten from `@docker` to `@file`: in labels mode
 * a per-app middleware is defined by the docker provider, here it is defined by
 * the same file that references it.
 */
export function labelsToDynamicConfig(labels: Record<string, string>): DynamicConfig {
  const config: DynamicConfig = { http: { routers: {}, services: {}, middlewares: {} } };

  for (const [rawKey, rawValue] of Object.entries(labels)) {
    if (!rawKey.startsWith('traefik.http.')) continue; // `traefik.enable` is provider-level

    // Plugin configuration is passed through verbatim — the OIDC plugin matches
    // its own PascalCase keys, and `Scopes[0]` style indices become arrays.
    const pluginAt = rawKey.indexOf('.plugin.');
    if (pluginAt !== -1) {
      const head = rawKey.slice('traefik.'.length, pluginAt).split('.');
      const tail = rawKey.slice(pluginAt + 1).split('.');
      applyIndexedPath(config, [...head, ...tail], rawValue);
      continue;
    }

    const segments = rawKey.slice('traefik.'.length).split('.');
    const path: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      // Router, service and middleware names are user data and must not be
      // renamed — only the schema keys around them are.
      const isName = i === 2;
      path.push(isName ? segments[i] : (RENAMES[segments[i]] ?? segments[i]));
    }

    const leaf = path[path.length - 1];
    let value: unknown = rawValue;

    if (leaf === 'url' && path[path.length - 2] === 'server') {
      // `services.X.loadBalancer.server.url` -> `servers: [{ url }]`
      setPath(config, [...path.slice(0, -2), 'servers'], [{ url: rawValue }]);
      continue;
    }
    if (LIST_LEAVES.has(leaf)) {
      value = rawValue.split(',').map((v) => v.trim().replace(/@docker$/, '@file')).filter(Boolean);
    } else if (NUMERIC_LEAVES.has(leaf)) {
      value = Number(rawValue);
    } else if (rawValue === 'true' || rawValue === 'false') {
      value = rawValue === 'true';
    }

    // `routers.x.tls: true` means "terminate TLS with the defaults"; the file
    // provider spells that as an empty object.
    if (leaf === 'tls' && value === true) {
      setPath(config, path, {});
      continue;
    }

    setPath(config, path, value);
  }

  return config;
}

/** Handle `Scopes[0]` / `AssertClaims[0].AnyOf[1]` segments, building arrays. */
function applyIndexedPath(root: any, path: string[], value: string): void {
  let node: any = root;
  for (let i = 0; i < path.length; i++) {
    const last = i === path.length - 1;
    const match = path[i].match(/^(.+)\[(\d+)\]$/);
    const key = match ? match[1] : path[i];
    const index = match ? Number(match[2]) : null;

    if (index === null) {
      if (last) {
        node[key] = value === 'true' ? true : value === 'false' ? false : value;
      } else {
        node[key] ??= {};
        node = node[key];
      }
      continue;
    }

    node[key] ??= [];
    if (last) {
      node[key][index] = value;
    } else {
      node[key][index] ??= {};
      node = node[key][index];
    }
  }
}

/**
 * Per-application Traefik options, derived from editable application settings.
 *
 * Shared with the deploy path so `labels` and `http` mode workers apply exactly
 * the same rate limit, auth mode and health check.
 */
export function buildMiddlewareOpts(app: any): AppMiddlewareOptions | undefined {
  const opts: AppMiddlewareOptions = {};
  let hasOpts = false;

  if (app.rateLimitAvg && app.rateLimitAvg > 0) {
    opts.rateLimitAvg = app.rateLimitAvg;
    opts.rateLimitBurst = app.rateLimitBurst || app.rateLimitAvg * 2;
    hasOpts = true;
  }

  if (app.authType === 'oidc' && app.authConfig) {
    try {
      opts.authType = 'oidc';
      opts.authConfig = JSON.parse(app.authConfig);
      hasOpts = true;
    } catch {
      // Invalid auth config, skip
    }
  }

  if (app.authType === 'none') {
    opts.authType = 'none';
    hasOpts = true;
  }

  // Extract health check path for Traefik routing
  if (app.healthcheck) {
    try {
      const hc = JSON.parse(app.healthcheck);
      const test = hc.test?.trim() || '';
      // Extract path from curl commands like "curl -f http://localhost:80/health"
      const curlMatch = test.match(/curl\s+.*https?:\/\/[^/]+(\/\S*)/);
      if (curlMatch) {
        opts.healthCheckPath = curlMatch[1].split(/\s+/)[0]; // strip trailing args
        hasOpts = true;
      }
    } catch { /* ignore */ }
  }

  return hasOpts ? opts : undefined;
}

/** One routed group: an application's containers sharing a hostname. */
export interface RouteGroup {
  routerBase: string;
  domain: string;
  ports: number[];
  /** Compose services carry no per-app middleware, matching the deploy path. */
  middlewareOpts?: AppMiddlewareOptions;
}

/** Merge `source` into `target`, later definitions winning per key. */
function mergeInto(target: DynamicConfig, source: DynamicConfig): void {
  Object.assign(target.http.routers, source.http.routers ?? {});
  Object.assign(target.http.services, source.http.services ?? {});
  Object.assign(target.http.middlewares, source.http.middlewares ?? {});
}

/** Build the dynamic configuration for one set of route groups. */
export function configForRouteGroups(groups: RouteGroup[], globalOidcEnabled: boolean): DynamicConfig {
  const config: DynamicConfig = { http: { routers: {}, services: {}, middlewares: {} } };

  for (const group of groups) {
    if (!group.ports.length || !group.domain) continue;

    const labels = generateTraefikLabelsForApp(
      group.routerBase,
      group.domain,
      group.ports[0],
      true,
      group.middlewareOpts,
      globalOidcEnabled,
    );
    const generated = labelsToDynamicConfig(labels);

    // Replicas: one service, one server per container. The labels only ever
    // describe a single backend; this is the part that makes blue/green a
    // change to this function rather than a container recreate.
    const service = generated.http.services[group.routerBase];
    if (service?.loadBalancer) {
      service.loadBalancer.servers = group.ports.map((port) => ({ url: `http://127.0.0.1:${port}` }));
    }

    mergeInto(config, generated);
  }

  return config;
}

/**
 * Assemble the served document from already-resolved inputs.
 *
 * Split out from `buildWorkerDynamicConfig` so the part that decides what goes
 * over the wire is a pure function with tests — in particular that empty
 * sections never survive, which Traefik rejects at whole-file granularity.
 */
export function assembleWorkerConfig(
  groups: RouteGroup[],
  globalOidcEnabled: boolean,
  globalOidcMiddleware?: DynamicConfig | null,
): ServedConfig {
  const config = configForRouteGroups(groups, globalOidcEnabled);
  if (globalOidcMiddleware) mergeInto(config, globalOidcMiddleware);
  return pruneEmptySections(config);
}

/**
 * The complete dynamic configuration for a worker.
 *
 * `crowdsec` and `security-headers` are deliberately absent: they never change,
 * and leaving them in their own static file means a worker that somehow ends up
 * with no routes still has its protective middlewares. Worker OIDC *is*
 * included, so changing it no longer needs a manual push.
 */
export async function buildWorkerDynamicConfig(workerId: string): Promise<ServedConfig> {
  // Imported lazily so the pure generators above stay usable from tests and
  // from modules that must not open the database.
  const [{ db }, { applications, containers, workers }, { and, eq }, { decryptField, encryptField }] =
    await Promise.all([
      import('$lib/db'),
      import('$lib/db/schema'),
      import('drizzle-orm'),
      import('./encryption'),
    ]);

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  const rows = await db
    .select({ app: applications, container: containers })
    .from(containers)
    .innerJoin(applications, eq(containers.applicationId, applications.id))
    .where(and(eq(containers.workerId, workerId), eq(containers.status, 'running')))
    .all();

  const byRouter = new Map<string, RouteGroup & { app: any }>();
  for (const { app, container } of rows) {
    if (!container.routerName || !container.domain || !container.exposedPort) continue;
    const existing = byRouter.get(container.routerName);
    if (existing) {
      existing.ports.push(container.exposedPort);
      continue;
    }
    byRouter.set(container.routerName, {
      app,
      routerBase: container.routerName,
      domain: container.domain,
      ports: [container.exposedPort],
      // Compose services get no per-app middleware in the deploy path either;
      // rate limits and per-app OIDC are single-container features today.
      middlewareOpts: app.type === 'compose' ? undefined : buildMiddlewareOpts(app),
    });
  }

  const globalOidcConfigured = !!(
    worker.oidcEnabled && worker.oidcProviderUrl && worker.oidcClientId &&
    worker.oidcClientSecret && worker.baseDomain
  );

  const groups = [...byRouter.values()].sort((a, b) => a.routerBase.localeCompare(b.routerBase));
  let globalOidcMiddleware: DynamicConfig | null = null;

  // Worker OIDC travels with the routes rather than being pushed over SSH, so
  // the middleware and the routers referencing it can never be out of step.
  if (globalOidcConfigured) {
    const clientSecret = decryptField(worker.oidcClientSecret);
    const { secret, rotated } = normalizeOidcSecret(decryptField(worker.oidcEncryptionKey));
    if (rotated) {
      // Persist immediately: this runs on every fetch, and a secret that is
      // regenerated each time would invalidate every session on every poll.
      await db.update(workers)
        .set({ oidcEncryptionKey: encryptField(secret) })
        .where(eq(workers.id, worker.id));
    }
    if (clientSecret) {
      globalOidcMiddleware = Bun.YAML.parse(
        renderGlobalOidcConfig(worker.baseDomain!, {
          providerURL: worker.oidcProviderUrl!,
          clientID: worker.oidcClientId!,
          clientSecret,
          secret,
        }),
      ) as DynamicConfig;
    }
  }

  return assembleWorkerConfig(groups, globalOidcConfigured, globalOidcMiddleware);
}
