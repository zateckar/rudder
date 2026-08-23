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
      // `shop-secure` and `shop-secure-ws` are the same service to a reader.
      router: key.slice('traefik.http.routers.'.length, -'.rule'.length).replace(/-secure(-ws)?$/, ''),
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

/** One entry per distinct hostname the application serves, for multi-service apps. */
export function serviceUrls(
  appContainers: readonly ContainerRow[],
): Array<{ name: string; url: string }> {
  const byUrl = new Map<string, { name: string; url: string }>();

  for (const row of appContainers) {
    if (row.domain) {
      const url = `https://${row.domain}`;
      if (!byUrl.has(url)) {
        byUrl.set(url, { name: row.routerName ?? row.name, url });
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
