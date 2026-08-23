import {
  ManifestError,
  createRouteAssigner,
  identityLabels,
  plannedContainerName,
  type DeploymentPlan,
  type PlanContext,
  type PlannedContainer,
  type PlannedHealthcheck,
} from './deploy/plan';
import { ALIAS_LABEL, assertDistinctAliases, networkAliases } from './networks';
import { describeYamlError } from './yaml-errors';
import type { MountIntent } from './mounts';
import { composeVolumeName, isHostPathSource, volumeBaseName } from './volumes';

export interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  ports?: string[] | { target?: number; published?: number; protocol?: string }[];
  volumes?: string[] | { type?: string; source?: string; target?: string; read_only?: boolean }[];
  environment?: Record<string, string> | string[];
  env_file?: string | string[];
  command?: string | string[];
  entrypoint?: string | string[];
  depends_on?: string[] | Record<string, { condition?: string }>;
  restart?: string;
  networks?: string[];
  labels?: Record<string, string>;
  mem_limit?: string | number;
  /** Fraction of a core, the v2 spelling of `deploy.resources.limits.cpus`. */
  cpus?: number | string;
  cpu_shares?: number;
  /**
   * The v3 spelling of the resource limits. Read because it is what people
   * actually write — and what this application's own example manifest shows —
   * while only `mem_limit`/`cpu_shares` used to be honoured, so a compose file
   * asking for 1 CPU and 512M got a container with neither and no note saying so.
   */
  deploy?: {
    resources?: {
      limits?: { cpus?: number | string; memory?: string | number };
    };
  };
  /**
   * Compose's own secrets, which are files on the machine running compose.
   * Rudder has no such machine and injects from its secrets store instead, so
   * this cannot be honoured — it is reported in the notes rather than ignored.
   */
  secrets?: unknown[];
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  expose?: string[] | number[];
  external_links?: string[];
  extra_hosts?: string[];
  dns?: string | string[];
  cap_add?: string[];
  cap_drop?: string[];
  privileged?: boolean;
  read_only?: boolean;
  stdin_open?: boolean;
  tty?: boolean;
  user?: string;
  working_dir?: string;
}

export interface ComposeConfig {
  version?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { driver?: string; external?: boolean }>;
  volumes?: Record<string, { driver?: string; external?: boolean }>;
}

export function parseCompose(manifest: string, ctx: PlanContext): DeploymentPlan {
  const { appName, baseDomain, allocatePort } = ctx;

  let config: ComposeConfig;
  try {
    config = Bun.YAML.parse(manifest) as ComposeConfig;
  } catch (e) {
    // A ManifestError, so this reaches the user as a refusal with a location
    // rather than as an unhandled parser exception.
    throw new ManifestError(describeYamlError(manifest, e));
  }

  if (!config || !config.services) {
    throw new ManifestError('Invalid compose file: no services defined');
  }

  // Services must start in dependency order. `depends_on` was parsed into the
  // type but never honoured — services deployed in object-key order, so a web
  // container could start before the database it needs.
  //
  // The sort is applied to the finished list, not to the parse loop: which
  // service owns the application hostname is decided by *declaration* order,
  // and a topological walk puts the dependencies first. Sorting the loop would
  // hand `<app>.<base>` to the database instead of the web front-end.
  const ordering = topologicalOrder(config.services);
  if ('cycle' in ordering) {
    throw new ManifestError(`Circular depends_on: ${ordering.cycle.join(' → ')}`);
  }

  // Compose keys are unique by construction, but they are not DNS labels:
  // `my_db` and `my-db` are two services that would answer to one alias.
  assertDistinctAliases(appName, Object.keys(config.services));

  const containers: PlannedContainer[] = [];
  const assignRoute = createRouteAssigner(ctx);

  /**
   * What this deploy did not do exactly as the file asked.
   *
   * The Kubernetes parser has recorded these from the start; the compose path
   * returned an empty array, so a compose file whose host ports were reallocated
   * and whose `traefik.*` labels were dropped deployed with no indication that
   * anything had been reinterpreted.
   */
  const notes: string[] = [];

  for (const serviceName of Object.keys(config.services)) {
    const service = config.services[serviceName];
    const containerName = plannedContainerName(ctx, serviceName);

    const env: Record<string, string> = {};
    
    if (service.environment) {
      if (Array.isArray(service.environment)) {
        for (const envEntry of service.environment) {
          // Split on the *first* `=` only. Destructuring `split('=')` kept the
          // second field and discarded the rest, so every value containing an
          // equals sign was silently truncated: `JAVA_OPTS=-Dfoo=bar` became
          // `-Dfoo`, base64 padding was stripped, and a connection string lost
          // its query parameters. The failure surfaced at runtime, in the
          // container, as a malformed credential.
          const separator = envEntry.indexOf('=');
          const key = separator === -1 ? envEntry : envEntry.slice(0, separator);
          if (key) {
            env[key] = separator === -1 ? '' : envEntry.slice(separator + 1);
          }
        }
      } else {
        Object.assign(env, service.environment);
      }
    }

    const ports: Record<string, Array<{ hostPort: string }>> = {};

    if (service.ports) {
      for (const portEntry of service.ports) {
        let containerPort: string;
        let proto = 'tcp';
        /** The host port the file asked for, if it named one. */
        let requestedHostPort: string | null = null;

        if (typeof portEntry === 'string') {
          // Formats: "CONTAINER", "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER/proto"
          const parts = portEntry.split(':');
          // Last segment is always container port (possibly with /proto suffix)
          const lastPart = parts[parts.length - 1];
          const [portNum, portProto] = lastPart.split('/');
          containerPort = portNum.replace(/['"]/g, '').trim();
          if (portProto) proto = portProto;
          if (parts.length > 1) {
            requestedHostPort = parts[parts.length - 2].replace(/['"]/g, '').trim() || null;
          }
        } else if (portEntry.target) {
          containerPort = String(portEntry.target).replace(/['"]/g, '').trim();
          if (portEntry.protocol) proto = portEntry.protocol;
          if (portEntry.published !== undefined) {
            requestedHostPort = String(portEntry.published).replace(/['"]/g, '').trim() || null;
          }
        } else {
          continue;
        }

        if (requestedHostPort && !isNaN(parseInt(requestedHostPort))) {
          notes.push(
            `Service "${serviceName}" asks to publish container port ${containerPort} on host ` +
              `port ${requestedHostPort}. Rudder allocates host ports itself so two applications ` +
              `can both listen on the same port, and Traefik routes to whichever it was given.`,
          );
        }

        if (!containerPort || isNaN(parseInt(containerPort))) continue;

        // Always assign our own host port — ignore whatever the compose file
        // specifies. Traefik handles external routing so host ports are
        // implementation details.
        //
        // The allocator is injected because it has to know which ports are
        // already taken on the worker. The unchecked random draw this replaced
        // could collide with another service in the same file, or with an
        // existing container, and the resulting bind failure surfaced as an
        // unrelated-looking container start error.
        const hostPort = allocatePort();
        ports[`${containerPort}/${proto}`] = [{ hostPort: String(hostPort) }];
      }
    }

    const mounts: MountIntent[] = [];

    if (service.volumes) {
      for (const volumeEntry of service.volumes) {
        let source: string;
        let target: string;
        let options = 'rw';

        if (typeof volumeEntry === 'string') {
          const parts = volumeEntry.split(':');
          source = parts[0];
          target = parts[1];
          options = parts[2] ?? 'rw';
        } else if (volumeEntry.target) {
          source = volumeEntry.source ?? '';
          target = volumeEntry.target;
          options = volumeEntry.read_only ? 'ro' : 'rw';
        } else {
          continue;
        }

        if (!target) continue;

        if (isHostPathSource(source)) {
          // The user knows their worker's filesystem; whether they may mount
          // this part of it is the executor's call, not the parser's.
          mounts.push({ kind: 'bind', source, target, mode: options });
          continue;
        }

        // Everything else is a named Podman volume, created on first use and
        // persisting across redeploys because the name is deterministic. A
        // relative source (./data, ~/cache) has to become one: bound literally
        // it would resolve against the control plane's working directory, not
        // the worker's.
        const name = source && !source.startsWith('.') && !source.startsWith('~')
          ? source
          : composeVolumeName(ctx.appId, serviceName, volumeBaseName(source, target));
        mounts.push({ kind: 'volume', name, target, mode: options });
      }
    }

    let restartPolicy = 'no';
    if (service.restart) {
      switch (service.restart) {
        case 'always':
        case 'on-failure':
        case 'unless-stopped':
          restartPolicy = service.restart;
          break;
        default:
          restartPolicy = 'no';
      }
    }

    const aliases = networkAliases(appName, serviceName);

    const labels: Record<string, string> = {
      ...identityLabels(ctx),
      service: serviceName,
      // The bare alias, recorded so a later deploy can see which names are
      // already claimed on the application's network without reparsing manifests.
      [ALIAS_LABEL]: aliases[0],
    };

    if (service.labels) {
      // Strip any traefik.* labels from user-provided compose to prevent route hijacking
      // (our auto-generated Traefik labels are applied below and should not be overridden)
      const entries = Object.entries(service.labels as Record<string, string>);
      const dropped = entries.filter(([k]) => k.toLowerCase().startsWith('traefik.'));
      const sanitized = Object.fromEntries(entries.filter(([k]) => !k.toLowerCase().startsWith('traefik.')));
      Object.assign(labels, sanitized);

      // Silently dropping routing labels is how someone spends an afternoon
      // wondering why their middleware never runs.
      if (dropped.length > 0) {
        notes.push(
          `Service "${serviceName}" sets ${dropped.length} traefik.* label` +
            `${dropped.length === 1 ? '' : 's'} (${dropped.map(([k]) => k).join(', ')}), which were ` +
            `dropped. Rudder generates its own routing labels, and honouring these would let one ` +
            `application take over another's hostname. Set the domain, rate limit and auth mode on ` +
            `the application instead.`,
        );
      }
    }
    
    // A service that publishes nothing has no route: it is reachable by its
    // siblings over the bridge, and by nobody else.
    const firstPortKey = Object.keys(ports)[0];
    const firstHostPort = firstPortKey ? ports[firstPortKey]?.[0]?.hostPort : undefined;
    const route = firstHostPort && baseDomain
      ? assignRoute(serviceName, parseInt(firstHostPort))
      : undefined;

    const limits = service.deploy?.resources?.limits;

    // `mem_limit` (v2) and `deploy.resources.limits.memory` (v3) say the same
    // thing; whichever the file used is honoured.
    let memory: number | undefined;
    const memoryLimit = service.mem_limit ?? limits?.memory;
    if (memoryLimit !== undefined && memoryLimit !== null && memoryLimit !== '') {
      memory =
        typeof memoryLimit === 'number' ? memoryLimit : parseMemory(memoryLimit) || undefined;
    }

    // A CPU limit is a fraction of a core, expressed over a 100ms period.
    // `cpu_shares` is a different thing — a relative weight under contention,
    // not a ceiling — so it is only consulted when no real limit was given, and
    // keeps the mapping it has always had rather than changing what running
    // applications get.
    let cpu: { cpuQuota: number; cpuPeriod: number } | undefined;
    const cpuLimit = limits?.cpus ?? service.cpus;
    if (cpuLimit !== undefined && cpuLimit !== null && cpuLimit !== '') {
      const cores = typeof cpuLimit === 'number' ? cpuLimit : parseFloat(cpuLimit);
      if (Number.isFinite(cores) && cores > 0) {
        cpu = { cpuQuota: Math.floor(cores * 100000), cpuPeriod: 100000 };
      }
    } else if (service.cpu_shares) {
      cpu = { cpuQuota: service.cpu_shares * 100, cpuPeriod: 100000 };
    }

    // Compose secrets name files on the host running compose. There is no such
    // host here, and guessing that a compose secret means the Rudder secret of
    // the same name would inject something the file did not ask for.
    if (Array.isArray(service.secrets) && service.secrets.length > 0) {
      notes.push(
        `Service "${serviceName}" declares ${service.secrets.length} compose secret` +
          `${service.secrets.length === 1 ? '' : 's'}, which were not mounted. Compose reads those ` +
          `from files on the machine running it; Rudder injects from its own secrets store instead, ` +
          `so add them under Secrets and they will reach the container as environment variables or ` +
          `as files in /run/secrets.`,
      );
    }

    // Parse healthcheck
    let healthcheck: PlannedHealthcheck | undefined;
    if (service.healthcheck) {
      const hc = service.healthcheck;
      let test: string[] = [];
      if (hc.test) {
        if (Array.isArray(hc.test)) {
          test = hc.test;
        } else {
          // Shell form: wrap in CMD-SHELL
          test = ['CMD-SHELL', hc.test];
        }
      }
      healthcheck = {
        test,
        interval: hc.interval ? parseDuration(hc.interval) : undefined,
        timeout: hc.timeout ? parseDuration(hc.timeout) : undefined,
        retries: hc.retries,
        startPeriod: hc.start_period ? parseDuration(hc.start_period) : undefined,
      };
    }

    containers.push({
      key: serviceName,
      name: containerName,
      image: service.image || `${serviceName}:latest`,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ports,
      mounts,
      aliases,
      restartPolicy,
      labels,
      command: service.command ? (Array.isArray(service.command) ? service.command : [service.command]) : undefined,
      entrypoint: service.entrypoint ? (Array.isArray(service.entrypoint) ? service.entrypoint : [service.entrypoint]) : undefined,
      workingDir: service.working_dir,
      memory,
      cpuQuota: cpu?.cpuQuota,
      cpuPeriod: cpu?.cpuPeriod,
      healthcheck,
      route,
    });
  }

  // Start order only — nothing here waits for a dependency to become healthy.
  // Applied to the finished list rather than to the parse loop: which service
  // owns the application hostname is decided by *declaration* order, and a
  // topological walk puts the dependencies first, which would hand
  // `<app>.<base>` to the database instead of the web front-end.
  const startPosition = new Map(ordering.order.map((name, i) => [name, i]));
  const positionOf = (c: PlannedContainer) =>
    startPosition.get(c.key) ?? Number.MAX_SAFE_INTEGER;
  containers.sort((a, b) => positionOf(a) - positionOf(b));

  // `depends_on: { condition: service_healthy }` promises the dependency is
  // *ready*, not merely started. Rudder only orders the starts, so a service
  // that cannot survive its database being slow will still race it. Stated
  // whenever the condition is written, because the failure is intermittent and
  // therefore easy to blame on anything else.
  const waiters = Object.entries(config.services)
    .filter(([, s]) => !Array.isArray(s.depends_on) && s.depends_on
      && Object.values(s.depends_on).some((d) => d?.condition && d.condition !== 'service_started'))
    .map(([name]) => name);
  if (waiters.length > 0) {
    notes.push(
      `${waiters.map((n) => `"${n}"`).join(', ')} declare a depends_on condition. Rudder starts ` +
        `services in dependency order but does not wait for a dependency to become healthy, so a ` +
        `service that cannot tolerate its dependency being slow should retry its own connection.`,
    );
  }

  // The counterpart of the Kubernetes multi-container note. Stated whenever the
  // shape occurs rather than when it bites: whether a container was configured
  // to talk to a sibling over localhost is in the application, not in the file.
  if (containers.length > 1) {
    notes.push(
      `This application runs ${containers.length} containers on a shared bridge network. They ` +
        `reach each other by service name — ${containers.map((c) => `"${c.key}"`).join(', ')} — ` +
        `and localhost reaches only the container it is used from. The container names on the ` +
        `worker carry a generation prefix; those aliases do not.`,
    );
  }

  return { containers, notes };
}

/** Normalise `depends_on`, which compose accepts as a list or a condition map. */
function dependenciesOf(service: ComposeService): string[] {
  const dep = service.depends_on;
  if (!dep) return [];
  return Array.isArray(dep) ? dep : Object.keys(dep);
}

/**
 * Order services so a service starts after everything it depends on.
 *
 * This is start ordering only — it does *not* wait for a dependency to become
 * healthy, so `condition: service_healthy` is not honoured. Applications still
 * need to tolerate a dependency that is up but not yet ready.
 *
 * Dependencies on services that are not defined in the file are ignored here;
 * `validateCompose` reports them so the user sees the typo rather than a silent
 * reordering.
 */
export function topologicalOrder(
  services: Record<string, ComposeService>
): { order: string[] } | { cycle: string[] } {
  const names = Object.keys(services);
  const known = new Set(names);
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(name: string): string[] | null {
    if (state.get(name) === 'done') return null;
    if (state.get(name) === 'visiting') {
      // Slice from where this name first appears to report just the cycle.
      return [...stack.slice(stack.indexOf(name)), name];
    }

    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of dependenciesOf(services[name])) {
      if (!known.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    order.push(name);
    return null;
  }

  for (const name of names) {
    const cycle = visit(name);
    if (cycle) return { cycle };
  }

  return { order };
}

/** Parse Docker duration string (e.g. "30s", "1m30s", "5m") to nanoseconds */
function parseDuration(dur: string): number {
  let totalMs = 0;
  const parts = dur.match(/(\d+)(h|m|s|ms|us|ns)/g);
  if (!parts) return 0;
  for (const part of parts) {
    const match = part.match(/^(\d+)(h|m|s|ms|us|ns)$/);
    if (!match) continue;
    const val = parseInt(match[1]);
    switch (match[2]) {
      case 'h': totalMs += val * 3600000; break;
      case 'm': totalMs += val * 60000; break;
      case 's': totalMs += val * 1000; break;
      case 'ms': totalMs += val; break;
      case 'us': totalMs += val / 1000; break;
      case 'ns': return val; // already nanoseconds
    }
  }
  return totalMs * 1_000_000; // convert ms to nanoseconds
}

function parseMemory(memStr: string): number {
  const match = memStr.match(/^(\d+)([bBkKmMgG]?)$/);
  if (!match) return 0;
  
  const value = parseInt(match[1], 10);
  const unit = match[2] || 'b';
  
  switch (unit.toLowerCase()) {
    case 'b':
      return value;
    case 'k':
      return value * 1024;
    case 'm':
      return value * 1024 * 1024;
    case 'g':
      return value * 1024 * 1024 * 1024;
    default:
      return value;
  }
}

export function validateCompose(manifest: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    const config = Bun.YAML.parse(manifest) as ComposeConfig;
    
    if (!config) {
      errors.push('Invalid YAML');
      return { valid: false, errors };
    }
    
    if (!config.services || Object.keys(config.services).length === 0) {
      errors.push('No services defined');
    }
    
    const services = config.services || {};
    for (const [name, service] of Object.entries(services)) {
      if (!service.image && !service.build) {
        errors.push(`Service "${name}" has no image or build defined`);
      }
      for (const dep of dependenciesOf(service)) {
        if (!(dep in services)) {
          errors.push(`Service "${name}" depends_on "${dep}", which is not defined`);
        }
      }
    }

    // Reported here rather than left to parseCompose, which throws — a cycle is
    // a user error in the manifest and belongs with the other validation output.
    if (Object.keys(services).length > 0) {
      const ordering = topologicalOrder(services);
      if ('cycle' in ordering) {
        errors.push(`Circular depends_on: ${ordering.cycle.join(' → ')}`);
      }
    }
  } catch (e) {
    errors.push(describeYamlError(manifest, e));
  }

  return { valid: errors.length === 0, errors };
}
