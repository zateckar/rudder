import { generateTraefikLabelsForApp } from './provisioning';
import { buildAppDomain, buildServiceDomain, routerName } from './domains';
import { ALIAS_LABEL, assertDistinctAliases, networkAliases } from './networks';
import type { MountIntent } from './mounts';
import { unreservedPort, type PortAllocator } from './ports';
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
  cpus?: number;
  cpu_shares?: number;
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

export interface ParsedContainer {
  name: string;
  image: string;
  env: string[];
  ports: Record<string, Array<{ hostPort: string }>>;
  /** What the service asked to mount. Policy is applied by the executor. */
  mounts: MountIntent[];
  restartPolicy: string;
  labels: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  memory?: number;
  cpuShares?: number;
  healthcheck?: {
    test: string[];
    interval?: number;   // nanoseconds
    timeout?: number;     // nanoseconds
    retries?: number;
    startPeriod?: number; // nanoseconds
  };
  networks?: string[];
  /** DNS names siblings can reach this container by. See `networkAliases`. */
  aliases: string[];
  /** Hostname this service is routed at, when it exposes a port. */
  domain?: string;
  /** Traefik router/service name for that hostname. */
  routerName?: string;
  /** Host port behind the route. */
  exposedPort?: number;
}

export interface ParseComposeOptions {
  appName: string;
  teamSlug?: string;
  baseDomain?: string;
  appId?: string;
  team?: { name: string; id: string };
  stack?: { name: string; id: string };
  /** Whether the worker has a usable global OIDC middleware deployed. */
  globalOidcEnabled?: boolean;
  /** Explicit hostname for the app's primary service (app.domain override). */
  appDomain?: string | null;
  /**
   * Whether to stamp `traefik.*` labels. False for workers in `http` routing
   * mode, where routing is served from the control plane instead — both at once
   * would give Traefik two routers with the same `Host()` rule.
   * The hostname is still computed and returned either way.
   */
  emitTraefikLabels?: boolean;
  /**
   * Allocates a free host port on the target worker. Supplied by the caller so
   * allocation can consult ports already taken by other containers; without it
   * ports are drawn at random, which is only safe in tests.
   */
  allocatePort?: PortAllocator;
}

export function parseCompose(
  manifest: string,
  options: ParseComposeOptions
): ParsedContainer[] {
  const {
    appName,
    teamSlug,
    baseDomain,
    appId,
    team,
    stack,
    globalOidcEnabled = false,
    appDomain,
    emitTraefikLabels = true,
    allocatePort,
  } = options;

  const config = Bun.YAML.parse(manifest) as ComposeConfig;

  if (!config || !config.services) {
    throw new Error('Invalid compose file: no services defined');
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
    throw new Error(`Circular depends_on: ${ordering.cycle.join(' → ')}`);
  }

  // Compose keys are unique by construction, but they are not DNS labels:
  // `my_db` and `my-db` are two services that would answer to one alias.
  assertDistinctAliases(appName, Object.keys(config.services));

  const appLabel = { app: appName };

  const containers: ParsedContainer[] = [];

  // The first service that exposes a port owns the application hostname; the
  // rest get <app>-<service>. Previously every service was routed at
  // `<app>.<baseDomain>`, so Traefik ended up with several routers sharing one
  // Host rule and picked between them arbitrarily.
  let primaryRouteTaken = false;

  for (const serviceName of Object.keys(config.services)) {
    const service = config.services[serviceName];
    const containerName = `${appName}-${appId ? appId.slice(0, 8) + '-' : ''}${serviceName}`;
    
    const env: Record<string, string> = {};
    
    if (service.environment) {
      if (Array.isArray(service.environment)) {
        for (const envEntry of service.environment) {
          const [key, value] = envEntry.split('=');
          if (key) {
            env[key] = value || '';
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

        if (typeof portEntry === 'string') {
          // Formats: "CONTAINER", "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER/proto"
          const parts = portEntry.split(':');
          // Last segment is always container port (possibly with /proto suffix)
          const lastPart = parts[parts.length - 1];
          const [portNum, portProto] = lastPart.split('/');
          containerPort = portNum.replace(/['"]/g, '').trim();
          if (portProto) proto = portProto;
        } else if (portEntry.target) {
          containerPort = String(portEntry.target).replace(/['"]/g, '').trim();
          if (portEntry.protocol) proto = portEntry.protocol;
        } else {
          continue;
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
        const hostPort = allocatePort ? allocatePort() : unreservedPort();
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
          : composeVolumeName(appId, serviceName, volumeBaseName(source, target));
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
      ...appLabel,
      service: serviceName,
      // The bare alias, recorded so a later deploy can see which names are
      // already claimed on a shared stack network without reparsing manifests.
      [ALIAS_LABEL]: aliases[0],
      // Marks the container as Rudder's. The reconciler will only ever delete
      // containers carrying this, so a co-tenant's workload is never garbage
      // collected off a shared worker.
      'rudder.managed': 'true',
    };

    if (teamSlug) {
      labels.team = teamSlug;
      if (team) {
        labels['rudder.team.name'] = team.name;
        labels['rudder.team.id'] = team.id;
      }
    }

    if (stack) {
      labels['rudder.stack.name'] = stack.name;
      labels['rudder.stack.id'] = stack.id;
    }

    if (service.labels) {
      // Strip any traefik.* labels from user-provided compose to prevent route hijacking
      // (our auto-generated Traefik labels are applied below and should not be overridden)
      const sanitized = Object.fromEntries(
        Object.entries(service.labels as Record<string, string>).filter(
          ([k]) => !k.toLowerCase().startsWith('traefik.')
        )
      );
      Object.assign(labels, sanitized);
    }
    
    // Check if service has ports exposed - if so, it gets a route
    const hasExposedPorts = ports && Object.keys(ports).length > 0;
    let serviceDomain: string | undefined;
    let serviceRouter: string | undefined;
    let serviceExposedPort: number | undefined;

    if (hasExposedPorts && baseDomain) {
      // Get the first port for Traefik routing
      const firstPortKey = Object.keys(ports)[0];
      const firstPortBinding = ports[firstPortKey]?.[0]?.hostPort;

      if (firstPortBinding) {
        const isPrimary = !primaryRouteTaken;
        primaryRouteTaken = true;
        serviceDomain = isPrimary
          ? (appDomain || buildAppDomain(appName, baseDomain) || appName)
          : (buildServiceDomain(appName, serviceName, baseDomain) || `${appName}-${serviceName}`);
        serviceRouter = isPrimary ? routerName(appName) : routerName(appName, serviceName);
        serviceExposedPort = parseInt(firstPortBinding);

        if (emitTraefikLabels) {
          const traefikLabels = generateTraefikLabelsForApp(
            serviceRouter,
            serviceDomain,
            serviceExposedPort,
            true, // Enable WebSocket for terminals
            undefined, // middlewareOpts
            globalOidcEnabled
          );

          // Merge Traefik labels with existing labels
          Object.assign(labels, traefikLabels);
        }
      }
    }

    let memory: number | undefined;
    if (service.mem_limit) {
      if (typeof service.mem_limit === 'number') {
        memory = service.mem_limit;
      } else {
        memory = parseMemory(service.mem_limit);
      }
    }

    let cpuShares: number | undefined;
    if (service.cpu_shares) {
      cpuShares = service.cpu_shares;
    }

    // Parse healthcheck
    let healthcheck: ParsedContainer['healthcheck'];
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
      name: containerName,
      image: service.image || `${serviceName}:latest`,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ports,
      mounts,
      restartPolicy,
      labels,
      command: service.command ? (Array.isArray(service.command) ? service.command : [service.command]) : undefined,
      entrypoint: service.entrypoint ? (Array.isArray(service.entrypoint) ? service.entrypoint : [service.entrypoint]) : undefined,
      workingDir: service.working_dir,
      memory,
      cpuShares,
      healthcheck,
      networks: service.networks,
      aliases,
      domain: serviceDomain,
      routerName: serviceRouter,
      exposedPort: serviceExposedPort,
    });
  }

  // Start order only — nothing here waits for a dependency to become healthy.
  const startPosition = new Map(ordering.order.map((name, i) => [name, i]));
  const positionOf = (c: ParsedContainer) =>
    startPosition.get(c.labels['service'] ?? '') ?? Number.MAX_SAFE_INTEGER;
  return containers.sort((a, b) => positionOf(a) - positionOf(b));
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
  } catch (e: any) {
    errors.push(`YAML parse error: ${e.message}`);
  }
  
  return { valid: errors.length === 0, errors };
}
