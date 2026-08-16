/**
 * Canonical application hostnames.
 *
 * Every deployment path — UI form, template instantiation, compose import,
 * `kubectl apply`, single container, compose stack, k8s manifest — must build
 * hostnames through this module.  Previously each path rolled its own string,
 * so the same application ended up at `app.base`, `app.team.base` or
 * `service.base` depending on how it was created.
 *
 * The scheme is a single flat label: `<app>.<baseDomain>`.  The team is
 * deliberately *not* part of the hostname, which means application names must
 * be unique across teams — `assertDomainAvailable` enforces that at every
 * write site.
 */

/** Lowercase a value into a single valid DNS label. */
export function toDnsLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** `<app>.<baseDomain>` — the canonical hostname for an application. */
export function buildAppDomain(appName: string, baseDomain?: string | null): string | null {
  const label = toDnsLabel(appName);
  if (!baseDomain || !label) return null;
  return `${label}.${baseDomain}`;
}

/**
 * Hostname for a secondary service/container of a multi-service application.
 * The primary service keeps the application hostname; the rest are
 * disambiguated inside the same label so one wildcard record still covers them:
 * `<app>-<service>.<baseDomain>`.
 */
export function buildServiceDomain(
  appName: string,
  serviceName: string,
  baseDomain?: string | null,
): string | null {
  const app = toDnsLabel(appName);
  const service = toDnsLabel(serviceName);
  if (!baseDomain || !app) return null;
  if (!service || service === app) return buildAppDomain(appName, baseDomain);
  return `${app}-${service}.${baseDomain}`;
}

/**
 * Traefik router/service name for an application's primary route, and for its
 * secondary services.  Kept in lockstep with the hostnames above so two apps
 * that happen to share a compose service name ("web", "api") cannot collide on
 * the same Traefik router.
 */
export function routerName(appName: string, serviceName?: string): string {
  const app = toDnsLabel(appName);
  const service = serviceName ? toDnsLabel(serviceName) : '';
  return !service || service === app ? app : `${app}-${service}`;
}

/** The id of the application already holding `domain`, or null. */
export async function findAppIdByDomain(
  domain: string,
  excludeApplicationId?: string,
): Promise<string | null> {
  // Imported lazily so the pure name helpers above stay usable from modules
  // that must not pull in the database singleton.
  const [{ db }, { applications }, { and, eq, ne }] = await Promise.all([
    import('$lib/db'),
    import('$lib/db/schema'),
    import('drizzle-orm'),
  ]);
  const row = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      excludeApplicationId
        ? and(eq(applications.domain, domain), ne(applications.id, excludeApplicationId))
        : eq(applications.domain, domain),
    )
    .get();
  return row?.id ?? null;
}

/**
 * Reject a hostname that another application already owns.  Returns an error
 * message, or null when the domain is free.
 *
 * The check is intentionally global (not scoped to a team): Traefik routes by
 * Host, so two applications sharing a hostname would produce two routers with
 * the same rule and non-deterministic routing between them.  Only the hostname
 * — which is public DNS either way — is revealed, never the owning team.
 */
export async function assertDomainAvailable(
  domain: string | null,
  excludeApplicationId?: string,
): Promise<string | null> {
  if (!domain) return null;
  const owner = await findAppIdByDomain(domain, excludeApplicationId);
  if (!owner) return null;
  return `The domain "${domain}" is already in use by another application. Choose a different application name, or set an explicit domain.`;
}
