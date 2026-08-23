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

/** Where a container sits in its application's Traefik route. */
export interface PlannedRoute {
  /** Hostname traffic arrives on. */
  domain: string;
  /** Traefik router and service name. */
  routerName: string;
  /** Host port Traefik proxies to. */
  hostPort: number;
  /**
   * False for replicas after the first. They add a server to the shared
   * service so Traefik load-balances across them, but must not redefine the
   * router — two routers with one `Host()` rule route arbitrarily.
   */
  definesRouter: boolean;
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
  route?: PlannedRoute;
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
 */
export function createRouteAssigner(ctx: PlanContext) {
  let primaryTaken = false;
  return function assign(key: string, hostPort: number): PlannedRoute {
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

    return {
      domain,
      routerName: isPrimary ? routerName(ctx.appName) : routerName(ctx.appName, key),
      hostPort,
      definesRouter: true,
    };
  };
}
