/**
 * The hostnames an application is reachable on, read back off its containers.
 *
 * Two copies of this lived in `applications/+page.server.ts` and
 * `applications/[id]/+page.server.ts`. They had already drifted: the list page
 * used the raw router name as the service label and kept the `-secure` suffix
 * Traefik routers carry, so the same application was called `shop` on its own
 * page and `shop-secure` in the list. Both also took an `appName` parameter
 * neither one used.
 *
 * This reads container *labels*, which only exist on `labels`-mode workers. In
 * `http` routing mode the route lives in `containers.domain` / `router_name`
 * instead, so `primaryUrl` falls back to those before it tries the labels —
 * otherwise an http-mode application shows no URL at all unless someone set an
 * explicit domain.
 */
import type { containers } from '$lib/db/schema';
import {
  ENTRYPOINT_PORTS,
  MAX_ROUTES_PER_CONTAINER,
  ROUTE_ENTRYPOINTS,
  parseExposedPorts,
} from './deploy/plan';
import { routerDisplayName } from './domains';

type ContainerRow = typeof containers.$inferSelect;

/** `Host(\`app.example.com\`)` → `app.example.com`. */
const HOST_RULE = /Host\(`([^`]+)`\)/;

function parseLabels(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Every `(routerName, host)` pair a container's Traefik labels define. */
function* routerHosts(row: ContainerRow): Generator<{ router: string; host: string }> {
  const labels = parseLabels(row.labels);
  if (!labels) return;
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith('traefik.http.routers.') || !key.endsWith('.rule')) continue;
    const host = typeof value === 'string' ? value.match(HOST_RULE)?.[1] : undefined;
    if (!host) continue;
    yield {
      // `shop-secure` and `shop-secure-ws` are the same service to a reader, and
      // the `-<app8>` a router identifier carries is not something to show them
      // either — see `traefikRouterName`.
      router: routerDisplayName(
        key.slice('traefik.http.routers.'.length, -'.rule'.length).replace(/-secure(-ws)?$/, ''),
      ),
      host,
    };
  }
}

/**
 * The application's own URL: the domain an operator set, else whatever its
 * containers actually route.
 */
export function primaryUrl(
  appDomain: string | null | undefined,
  appContainers: readonly ContainerRow[],
): string | null {
  if (appDomain) return `https://${appDomain}`;

  // http routing mode: the route is in the column, not in a label.
  for (const row of appContainers) {
    if (row.domain) return `https://${row.domain}`;
  }

  for (const row of appContainers) {
    for (const { host } of routerHosts(row)) return `https://${host}`;
  }
  return null;
}

/** One port an application answers on, as something to render. */
export interface RouteUrl {
  /** Container port behind this URL. */
  containerPort: number;
  /** Public port, from the entryPoint. */
  publicPort: number;
  url: string;
  /**
   * Whether the application's OIDC login covers this route.
   *
   * False on every port but 443, always — OIDC is an interactive browser
   * redirect and the extra entryPoints carry machine traffic that cannot follow
   * one. Rendered rather than implied, because an operator who switched
   * authentication on is entitled to see what it reaches without reading the
   * routing code.
   */
  authenticated: boolean;
}

/**
 * Every hostname:port one container answers on.
 *
 * Reads `containers.routes`, which is null for anything deployed before extra
 * entryPoints existed — those fall back to the single 443 route the primary
 * columns describe.
 */
export function routeUrls(row: ContainerRow, oidcEnabled: boolean): RouteUrl[] {
  const domain = row.domain;
  if (!domain) return [];

  const stored = ((): Array<{ entryPoint?: string; containerPort?: number }> => {
    if (!row.routes) return [];
    try {
      const parsed = JSON.parse(row.routes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  if (stored.length === 0) {
    return [
      {
        containerPort: 0,
        publicPort: ENTRYPOINT_PORTS[ROUTE_ENTRYPOINTS[0]],
        url: `https://${domain}`,
        authenticated: oidcEnabled,
      },
    ];
  }

  return stored.flatMap((route, index) => {
    const publicPort = ENTRYPOINT_PORTS[String(route?.entryPoint ?? '')];
    if (!publicPort) return [];
    return [
      {
        containerPort: Number(route?.containerPort) || 0,
        publicPort,
        // 443 is the default, so naming it would make the common case look
        // unusual. Everything else has to carry its port to be usable.
        url: publicPort === 443 ? `https://${domain}` : `https://${domain}:${publicPort}`,
        authenticated: oidcEnabled && index === 0,
      },
    ];
  });
}

/**
 * Ports the application declared public that produced no route, and why.
 *
 * A page listing two URLs when the user declared three, without saying what
 * happened to the third, generates precisely one support question. The deploy
 * notes already say it once, at deploy time; this is the version still visible
 * a week later.
 */
export function unroutedPorts(
  app: { exposedPorts: string | null },
  appContainers: readonly ContainerRow[],
): Array<{ port: number; reason: string }> {
  const declared = parseExposedPorts(app.exposedPorts);
  if (!declared || declared.length === 0) return [];

  const routed = new Set<number>();
  for (const row of appContainers) {
    if (row.state !== 'active' || !row.routes) continue;
    try {
      for (const route of JSON.parse(row.routes) ?? []) {
        const port = Number(route?.containerPort);
        if (Number.isInteger(port)) routed.add(port);
      }
    } catch {
      // A row we cannot read tells us nothing about what is routed. Saying
      // "not routed" on that basis would be a guess presented as a finding.
      return [];
    }
  }

  return declared
    .filter((port) => !routed.has(port))
    .map((port) => ({
      port,
      reason:
        declared.indexOf(port) >= MAX_ROUTES_PER_CONTAINER
          ? `past the ${MAX_ROUTES_PER_CONTAINER}-port limit — a worker has ${MAX_ROUTES_PER_CONTAINER} HTTPS entryPoints`
          : 'not published by any container, or published over UDP only',
    }));
}

/** One entry per distinct hostname the application serves, for multi-service apps. */
export function serviceUrls(
  appContainers: readonly ContainerRow[],
): Array<{ name: string; url: string }> {
  const byUrl = new Map<string, { name: string; url: string }>();

  for (const row of appContainers) {
    if (row.domain) {
      const url = `https://${row.domain}`;
      if (!byUrl.has(url)) {
        byUrl.set(url, { name: routerDisplayName(row.routerName ?? row.name), url });
      }
    }
    const labels = parseLabels(row.labels);
    for (const { router, host } of routerHosts(row)) {
      const url = `https://${host}`;
      if (byUrl.has(url)) continue;
      byUrl.set(url, { name: labels?.service || router, url });
    }
  }

  return [...byUrl.values()];
}
