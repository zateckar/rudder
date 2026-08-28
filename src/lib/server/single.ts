/**
 * The single-container deployment format.
 *
 * Not a manifest language — the application form writes a small JSON blob, or
 * in the oldest applications just a bare image reference. It lived inline in
 * the middle of `executeApplicationDeploy`, which is why it was the one format
 * with no parser, no type and no tests.
 */
import {
  ManifestError,
  createRouteAssigner,
  identityLabels,
  plannedContainerName,
  routeSelectionNotes,
  selectRouteBindings,
  type DeploymentPlan,
  type PlanContext,
  type PlannedContainer,
  type PlannedHealthcheck,
  type PlannedRoute,
} from './deploy/plan';
import { SINGLE_IMAGE_KEY } from './image-digests';
import type { MountIntent } from './mounts';
import { ALIAS_LABEL, networkAliases } from './networks';

/** What the application form stores in `applications.manifest`. */
export interface SingleConfig {
  image: string;
  command?: string;
  workingDir?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  ports?: Array<{ containerPort: string; hostPort: string; protocol: string }>;
}

/** The most replicas one application may run. */
export const MAX_REPLICAS = 10;

/** One wording, whichever check catches it. */
const NO_IMAGE = 'This application has no image to deploy. Edit it and set a container image.';

/**
 * Parse the manifest column, tolerating the bare-image form.
 *
 * The bare-image fallback applies only to a manifest that is not JSON at all.
 * It used to catch *any* failure, including well-formed JSON that simply had no
 * image — so `{"image":"","ports":[]}` came back as an image reference of
 * `{"image":"","ports":[]}`, and the deploy failed with Podman complaining
 * about an invalid reference format for a string the user never typed.
 */
export function parseSingleConfig(manifest: string): SingleConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    // The oldest applications stored the image reference and nothing else.
    const bare = manifest.trim();
    if (!bare) throw new ManifestError(NO_IMAGE);
    return { image: bare };
  }

  if (parsed && typeof parsed === 'object') {
    const cfg = parsed as SingleConfig;
    if (typeof cfg.image === 'string' && cfg.image.trim()) return cfg;
    throw new ManifestError(NO_IMAGE);
  }

  // A JSON scalar: `"nginx"` with the quotes, which is still a reference.
  const scalar = String(parsed).trim();
  if (!scalar) throw new ManifestError(NO_IMAGE);
  return { image: scalar };
}

export interface ParseSingleOptions {
  /** Already-resolved mount intents; the registry lookup needs a database. */
  mounts?: MountIntent[];
}

export function parseSingle(
  manifest: string,
  ctx: PlanContext,
  options: ParseSingleOptions = {},
): DeploymentPlan {
  // Git-based builds required an SSH key held server-side; that was removed
  // when keys moved to the browser vault, so the feature no longer exists.
  // Fail with a clear message instead of a generic build error.
  if (ctx.gitRepo) {
    throw new ManifestError(
      'Git-based builds are no longer supported — SSH keys are not stored server-side. ' +
        'Build the image in CI and deploy it by tag instead.',
    );
  }

  // parseSingleConfig already refuses a manifest with no image; this stays as a
  // belt-and-braces guard for a config built by some other caller.
  const cfg = parseSingleConfig(manifest);
  if (!cfg.image?.trim()) {
    throw new ManifestError(NO_IMAGE);
  }

  const replicaCount = Math.max(1, Math.min(MAX_REPLICAS, ctx.replicas ?? 1));

  // Every replica shares one alias on purpose: Podman's DNS returns all the
  // addresses behind a name, so a sibling that resolves it round-robins across
  // the replicas rather than pinning to whichever came up first.
  const aliases = networkAliases(ctx.appName, ctx.appName);
  const labels = { ...identityLabels(ctx), [ALIAS_LABEL]: aliases[0] };

  const healthcheck = parseHealthcheck(ctx.healthcheck);
  const command = cfg.command?.trim() ? cfg.command.trim().split(/\s+/) : undefined;
  const memory = cfg.memoryLimit ? parseMemory(cfg.memoryLimit) : undefined;
  const cpu = cfg.cpuLimit ? parseCpu(cfg.cpuLimit) : undefined;

  const assignRoute = createRouteAssigner(ctx);
  const containers: PlannedContainer[] = [];
  const notes: string[] = [];
  /** Set by the first replica; the rest join the routers it defined. */
  let sharedRoutes: PlannedRoute[] | null = null;

  for (let replica = 1; replica <= replicaCount; replica++) {
    const ports: Record<string, Array<{ hostPort: string }>> = {};

    if (cfg.ports && cfg.ports.length > 0) {
      for (const p of cfg.ports) {
        if (!p.containerPort) continue;
        // An explicit host port is honoured for a single replica — the user
        // asked for that number and something outside Rudder may depend on it.
        // Replicas cannot all hold it, so they are allocated instead.
        const hostPort = replicaCount > 1 || !p.hostPort?.trim()
          ? String(ctx.allocatePort())
          : p.hostPort.trim();
        ports[`${p.containerPort}/${p.protocol || 'tcp'}`] = [{ hostPort }];
      }
    } else {
      // No ports declared: assume a web application on 80, which is what the
      // form has always assumed, so it still gets a route.
      ports['80/tcp'] = [{ hostPort: String(ctx.allocatePort()) }];
    }

    const selection = selectRouteBindings(ctx.exposedPorts, ports);
    // Reported once, not once per replica: every replica publishes the same
    // container ports, so the same note repeated N times says nothing new.
    if (replica === 1) notes.push(...routeSelectionNotes(ctx.appName, selection));

    // Every replica is a server behind one router, so the routers are assigned
    // once and the rest inherit them with their own host ports. Assigning per
    // replica would disambiguate them as separate hostnames, which is the
    // opposite of load balancing.
    let routes: PlannedRoute[];
    if (!sharedRoutes) {
      sharedRoutes = assignRoute(ctx.appName, selection.bindings);
      routes = sharedRoutes;
    } else {
      // Matched by container port rather than by index: a replica's bindings are
      // built in the same order, but pairing them positionally would silently
      // point a route at the wrong port the first time that stops being true.
      const hostPortFor = new Map(selection.bindings.map((b) => [b.containerPort, b.hostPort]));
      routes = sharedRoutes
        .filter((r) => hostPortFor.has(r.containerPort))
        .map((r) => ({ ...r, hostPort: hostPortFor.get(r.containerPort)!, definesRouter: false }));
    }

    containers.push({
      key: ctx.appName,
      // One image, so the record is a bare reference rather than a JSON object
      // keyed by container name. Kept as it was so a rollback to a deployment
      // recorded before this refactor still finds its pin.
      digestKey: SINGLE_IMAGE_KEY,
      name: plannedContainerName(ctx, replicaCount > 1 ? String(replica) : undefined),
      image: cfg.image,
      env: parseEnvironment(ctx.environment),
      ports,
      mounts: options.mounts ?? [],
      aliases,
      labels: { ...labels },
      restartPolicy: ctx.restartPolicy || 'always',
      command,
      workingDir: cfg.workingDir || undefined,
      memory,
      cpuQuota: cpu?.cpuQuota,
      cpuPeriod: cpu?.cpuPeriod,
      healthcheck,
      routes,
    });
  }

  return { containers, notes };
}

/** `applications.environment` is `[{ key, value }]`; Podman wants `KEY=value`. */
export function parseEnvironment(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const entries: Array<{ key: string; value: string }> = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter((e) => e?.key?.trim()).map((e) => `${e.key}=${e.value}`);
  } catch {
    return [];
  }
}

/** Parse `applications.healthcheck` JSON into Podman's health check config. */
export function parseHealthcheck(raw: string | null | undefined): PlannedHealthcheck | undefined {
  if (!raw) return undefined;
  try {
    const hc = JSON.parse(raw);
    if (!hc?.test || !String(hc.test).trim()) return undefined;
    return {
      test: ['CMD-SHELL', hc.test],
      interval: hc.interval ? parseDuration(hc.interval) : undefined,
      timeout: hc.timeout ? parseDuration(hc.timeout) : undefined,
      retries: hc.retries ? parseInt(hc.retries) : undefined,
      startPeriod: hc.startPeriod ? parseDuration(hc.startPeriod) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Parse a duration such as "30s" or "1m30s" into nanoseconds. */
export function parseDuration(dur: string): number {
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
      case 'ns': return val;
    }
  }
  return totalMs * 1_000_000;
}

/** Parse a memory limit such as "512m" or "2g" into bytes. */
export function parseMemory(mem: string): number | undefined {
  if (!mem) return undefined;
  const match = mem.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)[bB]?$/);
  if (!match) return undefined;
  let val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'k') val *= 1024;
  else if (unit === 'm') val *= 1024 * 1024;
  else if (unit === 'g') val *= 1024 * 1024 * 1024;
  return Math.floor(val);
}

/** Parse a CPU limit such as "0.5" or "2" into a quota over a 100ms period. */
export function parseCpu(cpu: string): { cpuQuota: number; cpuPeriod: number } | undefined {
  if (!cpu) return undefined;
  const val = parseFloat(cpu);
  if (isNaN(val) || val <= 0) return undefined;
  return { cpuQuota: Math.floor(val * 100000), cpuPeriod: 100000 };
}
