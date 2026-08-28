/**
 * The one shape a deployment takes, whatever it was written as.
 *
 * A single-container application, a compose file and a Kubernetes manifest are
 * three ways of saying the same thing: run these containers, on this network,
 * with this storage, and route to that one. They used to converge only at
 * `podmanClient.createContainer` — the very last call — so secret resolution,
 * port allocation, digest pinning, label assembly, the routing decision, the
 * container row, generation bookkeeping, start and error wrapping were all
 * written out three times. The copies drifted, which is how Kubernetes
 * manifests came to lose their volumes and their `args`, and how only compose
 * containers ended up reachable by name.
 *
 * Now each format has one job: read its own syntax and produce a
 * `DeploymentPlan`. Everything after that happens once.
 *
 * Parsers are pure. They take no database, allocate nothing but host ports
 * (through an injected allocator), and decide nothing about Traefik labels —
 * they record *where* a container should be routed and leave stamping the
 * labels to the executor, which is the only thing that knows the worker's
 * routing mode.
 */
import type { MountIntent } from '../mounts';
import type { PortAllocator } from '../ports';
import {
  buildAppDomain,
  buildServiceDomain,
  domainFormatError,
  routerName,
  toDnsLabel,
  traefikRouterName,
} from '../domains';

/**
 * A manifest Rudder will not deploy, and why.
 *
 * Reported as a 400: the manifest is wrong, not the server. Thrown while the
 * plan is being built, which is before anything has been created or torn down.
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Traefik's public HTTPS entryPoints on a worker, in assignment order.
 *
 * Index 0 is 443 and cannot be anything else: ACME's TLS-ALPN-01 challenge is
 * served there and nowhere else, so a hostname with no router on 443 never
 * obtains the certificate the others would serve. An application's first routed
 * port therefore always lands on `websecure`.
 *
 * Must match `entryPoints` in `provisioning/shell/templates/traefik.yml` and the
 * ports the host firewall admits — `provisioning/index.test.ts` asserts the two
 * agree, and this list is the third copy that has to stay in step.
 */
export const ROUTE_ENTRYPOINTS = [
  'websecure',
  'websecure-1',
  'websecure-2',
  'websecure-3',
  'websecure-4',
] as const;

/** The port each entryPoint listens on, for building the URL a person types. */
export const ENTRYPOINT_PORTS: Readonly<Record<string, number>> = {
  websecure: 443,
  'websecure-1': 1443,
  'websecure-2': 2443,
  'websecure-3': 3443,
  'websecure-4': 4443,
};

/** One route per entryPoint, so this is also the ceiling on declared ports. */
export const MAX_ROUTES_PER_CONTAINER = ROUTE_ENTRYPOINTS.length;

/** Where a container sits in its application's Traefik route. */
export interface PlannedRoute {
  /** Hostname traffic arrives on. */
  domain: string;
  /** Traefik router and service name. */
  routerName: string;
  /** Host port Traefik proxies to. */
  hostPort: number;
  /** Port inside the container this route reaches. */
  containerPort: number;
  /**
   * Traefik entryPoint this route is bound to, from `ROUTE_ENTRYPOINTS`.
   *
   * Every route of one container shares a hostname and a certificate; the
   * entryPoint is the only thing that distinguishes them, which is why no extra
   * DNS record and no extra certificate is needed for a second published port.
   */
  entryPoint: string;
  /**
   * False for replicas after the first. They add a server to the shared
   * service so Traefik load-balances across them, but must not redefine the
   * router — two routers with one `Host()` rule route arbitrarily.
   */
  definesRouter: boolean;
}

/** A container port and the host port Traefik reaches it on. */
export interface RouteBinding {
  containerPort: number;
  hostPort: number;
}

/** A container health check, in the nanosecond units Podman expects. */
export interface PlannedHealthcheck {
  test: string[];
  interval?: number;
  timeout?: number;
  retries?: number;
  startPeriod?: number;
}

/**
 * A file to place inside the container before it starts.
 *
 * Delivered through Podman's archive upload, which mounts the container's
 * filesystem to service the request — tmpfs included — so the content is in
 * place the instant the entrypoint runs.
 */
export interface PlannedFile {
  /** Absolute directory inside the container. */
  dir: string;
  name: string;
  content: string;
  /** Octal permission bits. Defaults to 0644. */
  mode?: number;
}

export interface PlannedContainer {
  /**
   * Identifies the container within its application: the compose service name,
   * the Kubernetes container name, or the application's own name.
   *
   * Also the key a rollback pins digests by, so each container of a
   * multi-container application is restored to the bytes it actually ran.
   */
  key: string;
  /**
   * Key this container's image digest is recorded under, when it differs from
   * `key`. Single-container applications use `SINGLE_IMAGE_KEY`, which is the
   * empty string, so historical rollback records keep resolving.
   */
  digestKey?: string;
  /** Podman container name, before any generation suffix is applied. */
  name: string;
  image: string;
  /** `NAME=value`. Secrets are merged in by the executor, not here. */
  env: string[];
  /** Podman port bindings, keyed `<containerPort>/<protocol>`. */
  ports: Record<string, Array<{ hostPort: string }>>;
  mounts: MountIntent[];
  /** DNS names siblings reach this container by. */
  aliases: string[];
  /** Identity and user labels. Traefik labels are added by the executor. */
  labels: Record<string, string>;
  restartPolicy: string;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  memory?: number;
  cpuQuota?: number;
  cpuPeriod?: number;
  healthcheck?: PlannedHealthcheck;
  files?: PlannedFile[];
  /**
   * Every hostname:port this container answers on, in entryPoint order.
   *
   * Empty for a container that publishes nothing, and for every container on a
   * worker with no base domain. Index 0 is the 443 route and is the one the
   * `containers` row records in its `domain`/`router_name`/`exposed_port`
   * columns; the rest are additive.
   */
  routes: PlannedRoute[];
}

export interface DeploymentPlan {
  /** In start order. Compose honours `depends_on`; the rest are declaration order. */
  containers: PlannedContainer[];
  /**
   * Things the user has to be told about this deployment — a Kubernetes
   * semantic that does not survive the translation, an ignored field. Surfaced
   * on the deployment rather than logged, because a note nobody reads is the
   * same as the silence it replaced.
   */
  notes: string[];
}

/** Everything a parser needs about the application, and nothing about the worker. */
export interface PlanContext {
  appId: string;
  appName: string;
  /** `applications.domain`, when the user set an explicit hostname. */
  appDomain?: string | null;
  /** The worker's base domain; without it nothing gets routed. */
  baseDomain?: string | null;
  teamSlug?: string;
  team?: { id: string; name: string };
  /** Draws a free host port on the target worker. Collision-checked by the caller. */
  allocatePort: PortAllocator;
  /** `applications.replicas`, honoured by the single-container format. */
  replicas?: number | null;
  /** `applications.environment` JSON, for formats with nowhere else to put it. */
  environment?: string | null;
  /** `applications.restartPolicy`, the fallback when a manifest names none. */
  restartPolicy?: string | null;
  /**
   * `applications.exposedPorts` — which container ports are public, in the
   * order they take entryPoints.
   *
   * Null means undeclared, and keeps the behaviour every application had before
   * this existed: the first published port is routed and the rest are reachable
   * only from the worker and from sibling containers. An empty array is a
   * different statement — declared, route nothing — and the two must not be
   * collapsed.
   */
  exposedPorts?: number[] | null;
  /** `applications.healthcheck` JSON, for formats that have nowhere else to put one. */
  healthcheck?: string | null;
  /** `applications.gitRepo`, set only by applications configured to build from source. */
  gitRepo?: string | null;
}

/**
 * The Podman name for a container of this application.
 *
 * The application id is in there because container names are global on a
 * worker and application names are not: two teams may each have a `web`.
 */
export function plannedContainerName(ctx: PlanContext, suffix?: string): string {
  const base = `${ctx.appName}-${ctx.appId.slice(0, 8)}`;
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * Labels every container of every format carries.
 *
 * `rudder.managed` is the reconciler's ownership marker: it will only ever
 * delete containers carrying it, so a co-tenant's workload on a shared worker
 * is never garbage collected. Previously only some formats set it.
 *
 * `rudder.app.id` says *which* application owns it. The `app` label carries the
 * name, which is not enough: names are not unique across teams, and renaming an
 * application would strand its containers under a name nothing claims. The id
 * is what lets the reconciler tell an orphan — managed, but belonging to an
 * application that no longer exists — from a container of a different app.
 */
export function identityLabels(ctx: PlanContext): Record<string, string> {
  const labels: Record<string, string> = {
    app: ctx.appName,
    'rudder.managed': 'true',
    'rudder.app.id': ctx.appId,
  };
  if (ctx.teamSlug) labels.team = ctx.teamSlug;
  if (ctx.team) {
    labels['rudder.team.name'] = ctx.team.name;
    labels['rudder.team.id'] = ctx.team.id;
  }
  return labels;
}

/**
 * Hand out the application's routes.
 *
 * The first container that exposes a port owns the application hostname; the
 * rest are disambiguated as `<app>-<key>` inside the same DNS label, so one
 * wildcard record still covers them. Before this rule existed every container
 * of a multi-container application reused the application hostname, giving
 * Traefik several routers with an identical `Host()` rule to choose between.
 *
 * A container's *own* extra ports are a different axis and do not work that way:
 * they share the container's hostname and take a different entryPoint instead.
 * That is what makes a second published port free of new DNS and new
 * certificates — only the router name has to differ, and router names are
 * internal.
 */
export function createRouteAssigner(ctx: PlanContext) {
  let primaryTaken = false;
  return function assign(key: string, bindings: readonly RouteBinding[]): PlannedRoute[] {
    if (bindings.length === 0) return [];
    const isPrimary = !primaryTaken;
    primaryTaken = true;
    // The last fallbacks go through `toDnsLabel` for the same reason
    // `routerName` does: a bare application name may contain spaces and other
    // characters that are not a hostname, and this value becomes the interior of
    // a Traefik `Host()` rule.
    const domain = isPrimary
      ? ctx.appDomain || buildAppDomain(ctx.appName, ctx.baseDomain) || toDnsLabel(ctx.appName)
      : buildServiceDomain(ctx.appName, key, ctx.baseDomain) || routerName(ctx.appName, key);

    // Enforced here, not only where the domain is written.
    //
    // Write-site validation cannot reach a row that was stored before it
    // existed, and this is the last point before the value is interpolated into
    // a router rule. A malformed hostname is refused as a manifest error, so the
    // deploy fails before anything is created or torn down rather than
    // installing a rule built from it. See `domainFormatError`.
    const malformed = domainFormatError(domain);
    if (malformed) {
      throw new ManifestError(
        `Cannot route "${ctx.appName}": ${malformed} Clear or correct the application's domain.`,
      );
    }

    // Carries the application id: a router name is global on a worker and an
    // application name is not. See `traefikRouterName`.
    const base = isPrimary
      ? traefikRouterName(ctx.appId, ctx.appName)
      : traefikRouterName(ctx.appId, ctx.appName, key);

    return bindings.slice(0, MAX_ROUTES_PER_CONTAINER).map((binding, index) => ({
      domain,
      // Index 0 keeps the unsuffixed name it has always had, so no deployed
      // application sees its router renamed by this feature and a worker's
      // existing routing configuration is byte-identical until someone declares
      // a second port.
      routerName: index === 0 ? base : `${base}-p${index}`,
      hostPort: binding.hostPort,
      containerPort: binding.containerPort,
      entryPoint: ROUTE_ENTRYPOINTS[index],
      definesRouter: true,
    }));
  };
}

/** Rejection message for a public-ports field that is not a port list. */
export const EXPOSED_PORTS_ERROR =
  'Public ports must be a comma-separated list of container port numbers, for example 7070, 8080.';

/**
 * `"7070, 8080"` → `[7070, 8080]`, or null when it is not a list of ports.
 *
 * The form the compose label and the kubectl annotation both use. Null and `[]`
 * are different answers: an unparseable value falls back to whatever declared
 * the ports at the next level up and says so, while an explicitly empty value
 * means route nothing. Reading a typo as "route nothing" would take an
 * application off the air over a stray character.
 */
export function parsePortList(value: string): number[] | null {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  const ports: number[] = [];
  for (const part of trimmed.split(',').map((p) => p.trim())) {
    if (!/^\d+$/.test(part)) return null;
    const port = Number(part);
    if (port < 1 || port > 65535) return null;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/**
 * The `exposed_ports` column as a list, or null for undeclared.
 *
 * Tolerant by construction. This value reaches the deploy path and the routing
 * generator, and a row that somehow holds something unexpected must degrade to
 * "undeclared" — the pre-existing single-route behaviour — rather than throw
 * and cost the application its routing entirely.
 */
export function parseExposedPorts(stored: string | null | undefined): number[] | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    const ports = parsed
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
    return [...new Set(ports)];
  } catch {
    return null;
  }
}

/** The list as the column stores it. Null for undeclared, so the column is null. */
export function serializeExposedPorts(ports: number[] | null | undefined): string | null {
  return ports === null || ports === undefined ? null : JSON.stringify(ports);
}

/** What `selectRouteBindings` could not honour, for the caller to report. */
export interface RouteSelection {
  bindings: RouteBinding[];
  /** Declared ports no container of this application publishes. */
  unpublished: number[];
  /** Declared ports past the entryPoint ceiling. */
  overflow: number[];
  /** Declared ports published only over UDP, which no HTTPS router can reach. */
  notTcp: number[];
}

/**
 * Which of a container's published ports get routed, and in what order.
 *
 * The declaration *is* the mapping: `[7070, 8080]` puts 7070 on 443 and 8080 on
 * 1443. Order is the user's, not the manifest's and not numeric — a rule derived
 * from either would silently re-point every client the day someone adds a port,
 * and routing is deliberately outside `specHash`, so reconciliation would not
 * even report the drift.
 *
 * With nothing declared this returns the first published binding and nothing
 * else, which is exactly what every application did before entryPoints 1-4
 * existed. That is the case almost every deployment is in, so it is the case
 * that must not change.
 *
 * @param ports Podman bindings keyed `<containerPort>/<protocol>`.
 */
export function selectRouteBindings(
  declared: readonly number[] | null | undefined,
  ports: Record<string, Array<{ hostPort: string }>>,
): RouteSelection {
  const byPort = new Map<number, { tcp?: number; any?: number }>();
  for (const [key, value] of Object.entries(ports)) {
    const hostPort = parseInt(value?.[0]?.hostPort ?? '');
    if (!Number.isFinite(hostPort)) continue;
    const [portPart, proto] = key.split('/');
    const containerPort = parseInt(portPart);
    if (!Number.isFinite(containerPort)) continue;
    const entry = byPort.get(containerPort) ?? {};
    if (entry.any === undefined) entry.any = hostPort;
    if ((proto || 'tcp') === 'tcp' && entry.tcp === undefined) entry.tcp = hostPort;
    byPort.set(containerPort, entry);
  }

  if (declared === null || declared === undefined) {
    // Insertion order, and any protocol: this is the pre-existing behaviour and
    // reproducing it exactly is the point. A UDP-only application got a route it
    // could not use, and still does — changing that here would be an unrelated
    // behaviour change riding along with this one.
    const first = Object.entries(ports)[0];
    if (!first) return { bindings: [], unpublished: [], overflow: [], notTcp: [] };
    const hostPort = parseInt(first[1]?.[0]?.hostPort ?? '');
    const containerPort = parseInt(first[0].split('/')[0]);
    if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) {
      return { bindings: [], unpublished: [], overflow: [], notTcp: [] };
    }
    return { bindings: [{ containerPort, hostPort }], unpublished: [], overflow: [], notTcp: [] };
  }

  const bindings: RouteBinding[] = [];
  const unpublished: number[] = [];
  const overflow: number[] = [];
  const notTcp: number[] = [];

  for (const containerPort of declared) {
    const entry = byPort.get(containerPort);
    if (!entry) {
      unpublished.push(containerPort);
      continue;
    }
    if (entry.tcp === undefined) {
      notTcp.push(containerPort);
      continue;
    }
    if (bindings.length >= MAX_ROUTES_PER_CONTAINER) {
      overflow.push(containerPort);
      continue;
    }
    bindings.push({ containerPort, hostPort: entry.tcp });
  }

  return { bindings, unpublished, overflow, notTcp };
}

/**
 * The notes `selectRouteBindings` owes the user, for a container it could not
 * route as declared.
 *
 * Separate from the selection so every format words it identically, and so the
 * silence that used to follow a typo — an application simply unreachable on a
 * port its owner believed they had configured — is one call away rather than
 * three copies to keep in step.
 */
export function routeSelectionNotes(label: string, selection: RouteSelection): string[] {
  const notes: string[] = [];
  if (selection.unpublished.length > 0) {
    notes.push(
      `"${label}" declares public port${selection.unpublished.length === 1 ? '' : 's'} ` +
        `${selection.unpublished.join(', ')}, which it does not publish. Nothing is routed there — ` +
        `add the port to the manifest, or remove it from the application's public ports.`,
    );
  }
  if (selection.notTcp.length > 0) {
    notes.push(
      `"${label}" declares public port${selection.notTcp.length === 1 ? '' : 's'} ` +
        `${selection.notTcp.join(', ')}, published over UDP only. Every entryPoint terminates TLS ` +
        `and speaks HTTP, so there is nothing for a router to do with them.`,
    );
  }
  if (selection.overflow.length > 0) {
    notes.push(
      `"${label}" declares more than ${MAX_ROUTES_PER_CONTAINER} public ports; ` +
        `${selection.overflow.join(', ')} ${selection.overflow.length === 1 ? 'was' : 'were'} not ` +
        `routed. There are ${MAX_ROUTES_PER_CONTAINER} HTTPS entryPoints on a worker.`,
    );
  }
  return notes;
}
