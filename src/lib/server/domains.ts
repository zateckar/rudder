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

/**
 * The Traefik router and service identifier for one of an application's routes.
 *
 * `routerName` above disambiguates *within* an application — two of its own
 * services called `web` and `api`. It cannot disambiguate *between* them,
 * because it is derived from the application name and application names are not
 * unique: `/applications/new` and the Kubernetes API both enforce uniqueness per
 * team, and the edit form enforces none at all. Two teams each with a `web`,
 * scheduled onto one worker, therefore produced the same router identifier —
 * which is global on a worker, exactly as `plannedContainerName` already notes
 * container names are.
 *
 * What that cost, in both routing modes:
 *
 * - **http** — `routeGroupsForWorker` keys its groups on this name, so the
 *   second application did not get a router of its own. Its container port was
 *   appended to the *first* application's load balancer, and requests for one
 *   team's hostname were round-robined into the other team's container.
 * - **labels** — two containers declared `traefik.http.routers.web.rule` with
 *   different `Host()` rules. Traefik's docker provider treats that as a
 *   conflicting definition and drops the router, taking both applications down.
 *
 * So the application id goes in, the same eight hex digits every other
 * per-application name in the system carries. Hostnames are untouched: this is
 * an internal identifier and `applications.domain` remains globally unique on
 * its own. `networkAliases` deliberately keeps using the bare `routerName` —
 * those are DNS names inside the application's own network, which is already
 * per-application, and suffixing them would break `<app>-<service>` resolution
 * between a manifest's own containers.
 */
export function traefikRouterName(
  appId: string,
  appName: string,
  serviceName?: string,
): string {
  return `${routerName(appName, serviceName)}-${appId.slice(0, 8)}`;
}

/** The `-<app8>` suffix `traefikRouterName` adds, for turning one back into a label. */
const ROUTER_ID_SUFFIX = /-[0-9a-f]{8}$/;

/**
 * A router identifier as something to show a person.
 *
 * The suffix exists to keep two teams' `web` apart on a worker; it means
 * nothing to whoever is reading the application's page.
 */
export function routerDisplayName(name: string): string {
  return name.replace(ROUTER_ID_SUFFIX, '');
}

/**
 * A hostname label: alphanumeric, inner hyphens, at most 63 characters.
 *
 * Exported so `schemas.domain` can be built from the same pattern rather than
 * its own copy — two regexes for one rule is how one of them ends up unused.
 */
export const DOMAIN_LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Why this hostname must not be stored, or null when it is a plain hostname.
 *
 * This is a security check, not a politeness one. The value reaches Traefik as
 * the interior of a router rule — ``Host(`<domain>`)`` in
 * `generateTraefikLabelsForApp`, in both routing modes — and Traefik parses that
 * rule as an expression. A backtick therefore closes the matcher and everything
 * after it is rule *logic*, not a hostname: `` a.example.com`) || Host(`victim.example.com ``
 * yields a second, longer router rule for a host the caller does not own.
 * Traefik orders routers by rule length, so the injected rule wins over the
 * victim's own, ACME issues a valid certificate for it (TLS-ALPN-01 is answered
 * by Traefik itself), and the request arrives carrying the *attacker's*
 * middleware chain — dropping whatever OIDC the victim had in front of it.
 *
 * The compose importer already strips caller-supplied `traefik.*` labels for
 * exactly this reason. This is the same rule applied to the other way in.
 */
export function domainFormatError(domain: string): string | null {
  // Deliberately validates the value as given rather than a trimmed copy. The
  // callers store what they were sent, so trimming here would accept
  // " app.example.com " and then write the spaces — passing validation and still
  // producing a router rule that matches nothing.
  if (!domain.trim()) return 'Domain is required';
  if (domain.length > 253) return 'Domain is too long (maximum 253 characters)';

  // Named separately from the label check below so the message says which
  // character is the problem — these are the ones that carry meaning inside a
  // Traefik rule, and "invalid hostname" would not explain the rejection.
  const injectable = domain.match(/[`'"()|&\s]/);
  if (injectable) {
    return `Domain "${domain}" contains an illegal character (${JSON.stringify(injectable[0])}). ` +
      `A domain must be a plain hostname such as app.example.com.`;
  }

  for (const label of domain.split('.')) {
    if (!label) return `Domain "${domain}" has an empty label`;
    if (!DOMAIN_LABEL.test(label)) {
      return `"${label}" is not a valid hostname label in "${domain}"`;
    }
  }

  return null;
}

/** The id of the application already holding `domain`, or null. */
export async function findAppIdByDomain(
  domain: string,
  excludeApplicationId?: string,
): Promise<string | null> {
  // Imported lazily so the pure name helpers above stay usable from modules
  // that must not pull in the database singleton.
  const reservations = await loadDomainReservations();
  const normalized = domain.toLowerCase();
  for (const [appId, domains] of reservations) {
    if (appId !== excludeApplicationId && domains.has(normalized)) return appId;
  }
  return null;
}

/** Inputs that decide public hostnames, shared by persisted rows and write sites. */
export interface ApplicationDomainInput {
  id: string;
  name: string;
  workerId?: string | null;
  domain?: string | null;
  type?: string | null;
  manifest?: string | null;
  exposedPorts?: string | null;
  environment?: string | null;
  restartPolicy?: string | null;
  healthcheck?: string | null;
}

const activeDomains = new Map<string, Set<string>>();
let domainPolicyTail = Promise.resolve();

/** Queue brief database/claim operations; unrelated workers can deploy in parallel. */
async function withDomainPolicy<T>(operation: () => Promise<T>): Promise<T> {
  const previous = domainPolicyTail;
  let release!: () => void;
  domainPolicyTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

export class DomainReservationError extends Error {}

/** Reuse the deployment parsers rather than guessing which services are public. */
export async function applicationPlannedDomains(
  app: ApplicationDomainInput,
  worker: { baseDomain?: string | null; hostname?: string | null } | undefined,
): Promise<Set<string>> {
  const domains = new Set<string>();
  if (app.domain) domains.add(app.domain.toLowerCase());
  if (!app.manifest || !worker) return domains;
  const [{ buildDeploymentPlan }, { parseExposedPorts }] = await Promise.all([
    import('./deploy/build'), import('./deploy/plan'),
  ]);
  let port = 1;
  const plan = buildDeploymentPlan({ type: app.type, manifest: app.manifest }, {
    appId: app.id, appName: app.name, appDomain: app.domain,
    baseDomain: process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname,
    exposedPorts: parseExposedPorts(app.exposedPorts),
    environment: app.environment, restartPolicy: app.restartPolicy,
    healthcheck: app.healthcheck, replicas: 1, allocatePort: () => port++,
  });
  for (const container of plan.containers) {
    for (const route of container.routes) domains.add(route.domain.toLowerCase());
  }
  return domains;
}

async function loadDomainReservations(): Promise<Map<string, Set<string>>> {
  const [{ db }, { applications, workers, containers }] = await Promise.all([
    import('$lib/db'),
    import('$lib/db/schema'),
  ]);
  const apps = db.select().from(applications).all();
  const workerRows = db.select().from(workers).all();
  const containerRows = db.select().from(containers).all();
  const result = new Map<string, Set<string>>();
  for (const app of apps) {
    let domains: Set<string>;
    try {
      domains = await applicationPlannedDomains(app, workerRows.find((worker) => worker.id === app.workerId));
    } catch {
      // A broken/new manifest must not erase a route still serving traffic.
      domains = new Set(app.domain ? [app.domain.toLowerCase()] : []);
    }
    result.set(app.id, domains);
  }
  for (const row of containerRows) {
    if (!row.applicationId) continue;
    const domains = result.get(row.applicationId) ?? new Set<string>();
    if (row.domain) domains.add(row.domain.toLowerCase());
    try {
      const routes: unknown = row.routes ? JSON.parse(row.routes) : [];
      if (Array.isArray(routes)) for (const route of routes) {
        if (typeof route?.domain === 'string') domains.add(route.domain.toLowerCase());
      }
    } catch { /* The legacy domain column remains reserved. */ }
    result.set(row.applicationId, domains);
  }
  for (const [appId, claims] of activeDomains) {
    const domains = result.get(appId) ?? new Set<string>();
    for (const domain of claims) domains.add(domain);
    result.set(appId, domains);
  }
  return result;
}

/** Check all routes together, including routes not yet deployed. */
export async function assertDomainsAvailable(domains: Iterable<string>, applicationId: string): Promise<string | null> {
  const reservations = await loadDomainReservations();
  for (const domain of domains) {
    const malformed = domainFormatError(domain);
    if (malformed) return malformed;
    for (const [owner, ownedDomains] of reservations) {
      if (owner !== applicationId && ownedDomains.has(domain.toLowerCase())) return domainConflictMessage(domain);
    }
  }
  return null;
}

/** Recheck the final plan and extend its live claims before worker mutations. */
export async function claimDeploymentDomains(domains: Iterable<string>, applicationId: string): Promise<string | null> {
    return await withDomainPolicy(async () => {
      const desired = [...domains];
      const conflict = await assertDomainsAvailable(desired, applicationId);
      if (conflict) return conflict;
      const claims = activeDomains.get(applicationId);
      if (!claims) return 'The deployment no longer holds its hostname reservations. Retry the deployment.';
      for (const domain of desired) claims.add(domain.toLowerCase());
      return null;
    });
}

async function candidateDomains(app: ApplicationDomainInput): Promise<Set<string>> {
  const [{ db }, { workers }, { eq }] = await Promise.all([
    import('$lib/db'), import('$lib/db/schema'), import('drizzle-orm'),
  ]);
  const worker = app.workerId ? db.select().from(workers).where(eq(workers.id, app.workerId)).get() : undefined;
  return applicationPlannedDomains(app, worker);
}

/** Atomic against other writes and deploy claims, without holding a fleet lock during a deploy. */
export async function withApplicationDomainWrite(
  app: ApplicationDomainInput,
  write: () => Promise<unknown>,
): Promise<string | null> {
    return await withDomainPolicy(async () => {
      // An edit during a deploy could change the plan after its domains were claimed.
      if (activeDomains.has(app.id)) return 'A deployment is running for this application. Retry the edit when it finishes.';
      let domains: Set<string>;
      try { domains = await candidateDomains(app); }
      catch (e) { return e instanceof Error ? e.message : String(e); }
      const conflict = await assertDomainsAvailable(domains, app.id);
      if (conflict) return conflict;
      await write();
      return null;
    });
}

/** Hold only this application's hostnames until its external deployment has finished. */
export async function withApplicationDeploymentDomains<T>(applicationId: string, deploy: () => Promise<T>): Promise<T> {
  const [{ db }, { applications }, { eq }] = await Promise.all([
    import('$lib/db'), import('$lib/db/schema'), import('drizzle-orm'),
  ]);
  await withDomainPolicy(async () => {
    const app = db.select().from(applications).where(eq(applications.id, applicationId)).get();
    if (!app) throw new DomainReservationError('Application not found');
    const domains = await candidateDomains(app);
    const conflict = await assertDomainsAvailable(domains, app.id);
    if (conflict) throw new DomainReservationError(conflict);
    if (activeDomains.has(app.id)) throw new DomainReservationError('A deployment is already running for this application.');
    for (const domain of (await loadDomainReservations()).get(app.id) ?? []) domains.add(domain);
    activeDomains.set(app.id, domains);
  });
  try { return await deploy(); }
  finally { activeDomains.delete(applicationId); }
}

function domainConflictMessage(domain: string): string {
  return `The domain "${domain}" is already in use by another application. Choose a different application name, or set an explicit domain.`;
}

/**
 * Reject a hostname Rudder must not route: malformed, or already owned by
 * another application.  Returns an error message, or null when it is usable.
 *
 * The conflict check is intentionally global (not scoped to a team): Traefik
 * routes by Host, so two applications sharing a hostname would produce two
 * routers with the same rule and non-deterministic routing between them.  Only
 * the hostname — which is public DNS either way — is revealed, never the owning
 * team.
 *
 * Format is checked *here*, ahead of the conflict, rather than at each caller.
 * Every write site already funnels through this function, so this is the one
 * place that cannot be forgotten by the next one — and being forgotten at three
 * separate sites (the edit form, the k8s `rudder.dev/domain` annotation, and the
 * create API) is exactly how an unvalidated hostname reached a Traefik rule. See
 * `domainFormatError` for what that allowed.
 */
export async function assertDomainAvailable(
  domain: string | null,
  excludeApplicationId?: string,
): Promise<string | null> {
  if (!domain) return null;

  const malformed = domainFormatError(domain);
  if (malformed) return malformed;

  const owner = await findAppIdByDomain(domain, excludeApplicationId);
  if (!owner) return null;
  return domainConflictMessage(domain);
}
