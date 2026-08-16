/**
 * Shared deploy logic — used by both the deploy API endpoint and the webhook trigger.
 */
import { db } from '$lib/db';
import { applications, workers, containers, teams, stacks, volumes, secrets, deployments } from '$lib/db/schema';
import { eq, inArray, or, desc } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { parseCompose, validateCompose } from '$lib/server/compose';
import { parseK8sManifest, validateK8sManifest } from '$lib/server/kubernetes';
import { generateTraefikLabelsForApp } from '$lib/server/provisioning';
// Shared with the config generator so `labels` and `http` mode workers apply
// exactly the same rate limit, auth mode and health check.
import { buildMiddlewareOpts } from '$lib/server/traefik-config';
import { buildAppDomain, buildServiceDomain, routerName } from '$lib/server/domains';
import { ALLOWED_DOMAINS_UNSUPPORTED } from '$lib/server/oidc';
import { decrypt } from '$lib/server/encryption';
import { ensureAppNetwork, teardownAppNetwork } from '$lib/server/networks';
import { env } from '$lib/server/env';
import { buildHostBind, MountPolicyError } from '$lib/server/mounts';
import {
  SINGLE_IMAGE_KEY,
  parseDigestRecord,
  pinnedImageFor,
  serializeDigestRecord,
} from '$lib/server/image-digests';
import { buildTar, MAX_TAR_NAME } from '$lib/server/tar';
// Traefik needs the OIDC client secret in the container's labels; Rudder's own
// database does not, and used to keep a plaintext copy of it there.
import { redactSecretLabels } from '$lib/server/redaction';

/** Parse memory string like "512m", "2g" -> bytes */
function parseMemory(mem: string): number | undefined {
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


/**
 * Where file-mode secrets are mounted, following the Docker/Podman convention
 * so images that already read `/run/secrets/<name>` need no change.
 */
const SECRETS_DIR = '/run/secrets';

/**
 * tmpfs, not a bind or an image layer: the values exist in the container's
 * memory and are gone when it stops. `mode=0700` on the directory and 0400 on
 * each file keep them to root inside the container.
 */
const SECRETS_TMPFS_OPTS = 'rw,noexec,nosuid,nodev,size=1m,mode=0700';

interface ResolvedSecrets {
  /** `NAME=value` strings for delivery mode `env`. */
  env: string[];
  /** Name/value pairs for delivery mode `file`. */
  files: Array<{ name: string; value: string }>;
}

/**
 * Resolve secrets from the secrets store for deployment injection.
 *
 * A secret whose value cannot be decrypted is dropped rather than deployed as
 * ciphertext — the same behaviour as before this split env from file delivery.
 */
async function resolveSecrets(teamId: string | null): Promise<ResolvedSecrets> {
  const conditions = [eq(secrets.scope, 'global')];
  if (teamId) {
    conditions.push(eq(secrets.teamId, teamId));
  }

  const rows = await db.select().from(secrets).where(or(...conditions)).all();

  const resolved: ResolvedSecrets = { env: [], files: [] };
  for (const s of rows) {
    let value: string;
    try {
      value = decrypt(s.value);
    } catch {
      continue;
    }
    if (s.deliveryMode === 'file') {
      resolved.files.push({ name: s.name, value });
    } else {
      resolved.env.push(`${s.name}=${value}`);
    }
  }
  return resolved;
}

/**
 * Write file-mode secrets into a created-but-not-started container.
 *
 * Uploading before start is deliberate: Podman mounts the container's
 * filesystem to service the archive upload — tmpfs included — so the files are
 * in place the instant the entrypoint runs, with no window where the process
 * is up and its configuration is not.
 */
async function deliverSecretFiles(
  podmanClient: ReturnType<typeof getRestPodmanClient>,
  containerId: string,
  files: Array<{ name: string; value: string }>,
): Promise<void> {
  if (files.length === 0) return;

  // The API constrains secret names to /^[A-Z_][A-Z0-9_]*$/, but this is the
  // point where a name becomes a path inside a container, so it is checked
  // again here rather than trusted. A `../` in a name would write outside
  // /run/secrets; an over-long one would overflow the USTAR name field.
  const safe = files.filter((f) => {
    const ok = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(f.name) && Buffer.byteLength(f.name) <= MAX_TAR_NAME;
    if (!ok) console.error(`[deploy] Refusing to deliver secret with unusable name: ${f.name}`);
    return ok;
  });
  if (safe.length === 0) return;

  const archive = buildTar(
    safe.map((f) => ({ name: f.name, content: f.value, mode: 0o400 })),
  );
  await podmanClient.putArchive(containerId, SECRETS_DIR, archive);
}

/** Parse duration string (e.g. "30s", "1m30s", "5m") to nanoseconds */
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
      case 'ns': return val;
    }
  }
  return totalMs * 1_000_000;
}

/** Parse app healthcheck JSON into Podman createContainer healthcheck config */
function parseHealthcheck(raw: string | null | undefined): {
  test: string[];
  interval?: number;
  timeout?: number;
  retries?: number;
  startPeriod?: number;
} | undefined {
  if (!raw) return undefined;
  try {
    const hc = JSON.parse(raw);
    if (!hc.test || !hc.test.trim()) return undefined;
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

// ── Host port allocation ─────────────────────────────────────────────────────

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 40000;

/**
 * Host ports already bound by containers on this worker.
 *
 * `excludeApplicationId` releases the ports held by the application being
 * redeployed, whose containers are torn down earlier in the same deploy.
 */
async function reservedPortsForWorker(
  workerId: string,
  excludeApplicationId?: string,
): Promise<Set<number>> {
  const rows = await db
    .select({
      applicationId: containers.applicationId,
      exposedPort: containers.exposedPort,
      ports: containers.ports,
    })
    .from(containers)
    .where(eq(containers.workerId, workerId))
    .all();

  const taken = new Set<number>();
  for (const row of rows) {
    if (excludeApplicationId && row.applicationId === excludeApplicationId) continue;
    if (row.exposedPort) taken.add(row.exposedPort);
    if (!row.ports) continue;
    try {
      // Stored as { "80/tcp": [{ hostPort: "31234" }], … }
      const parsed = JSON.parse(row.ports);
      for (const bindings of Object.values(parsed) as any[]) {
        for (const b of bindings ?? []) {
          const port = parseInt(b?.hostPort ?? b?.HostPort);
          if (Number.isInteger(port)) taken.add(port);
        }
      }
    } catch {
      // Unparseable port record — nothing to reserve.
    }
  }
  return taken;
}

/** Pick a free host port, falling back to a linear scan if draws keep colliding. */
function pickFreePort(taken: Set<number>): number {
  const span = PORT_RANGE_END - PORT_RANGE_START;
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = PORT_RANGE_START + Math.floor(Math.random() * span);
    if (!taken.has(candidate)) return candidate;
  }
  for (let port = PORT_RANGE_START; port < PORT_RANGE_END; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error(
    `No free host port available in range ${PORT_RANGE_START}-${PORT_RANGE_END} on this worker.`,
  );
}

/** Parse CPU string like "0.5", "2" -> cpuQuota (period=100000) */
function parseCpu(cpu: string): { cpuQuota: number; cpuPeriod: number } | undefined {
  if (!cpu) return undefined;
  const val = parseFloat(cpu);
  if (isNaN(val) || val <= 0) return undefined;
  return { cpuQuota: Math.floor(val * 100000), cpuPeriod: 100000 };
}

export interface DeployResult {
  success: boolean;
  message: string;
  error?: string;
  statusCode?: number;
}

/**
 * SSH config for a worker, used by teardownAppNetwork to run the Netavark
 * stale-rule cleanup after a network is removed.
 *
 * Always null: SSH keys live in the browser vault, not on the server, so no
 * deploy path can open an SSH session on its own. Kept as a named seam so the
 * call sites read clearly and can be wired up if server-held keys return.
 */
export async function resolveWorkerSSHConfig(
  _worker: typeof workers.$inferSelect,
): Promise<null> {
  return null;
}

export interface DeployOptions {
  /**
   * `deployments.image_digest` from the deployment being restored.
   *
   * Present only for a rollback or a redeploy of a historical version: the
   * containers are then created from those digests instead of whatever the
   * manifest's tags resolve to today, which is the entire point of recording
   * them. A digest the registry no longer has fails the deploy with a message
   * naming it rather than silently running something else.
   */
  pinnedDigests?: string | null;
}

/**
 * Execute a deploy for the given application.
 * @param applicationId - the application to deploy
 * @param deployedByUserId - the user who triggered the deploy (null for webhook triggers)
 * @param options - see DeployOptions; rollback supplies the recorded digests
 */
export async function executeApplicationDeploy(
  applicationId: string,
  deployedByUserId: string | null = null,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const app = await db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!app) return { success: false, message: 'Application not found', statusCode: 404 };
  if (!app.workerId) return { success: false, message: 'No worker assigned to this application', statusCode: 400 };

  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) return { success: false, message: 'Worker not found', statusCode: 404 };

  const globalOidcConfigured = !!(
    worker.oidcEnabled && worker.oidcProviderUrl && worker.oidcClientId &&
    worker.oidcClientSecret && worker.baseDomain
  );

  // In http routing mode the worker fetches the OIDC middleware together with
  // the routers that reference it, so the two can never be out of step and the
  // manual push is gone.
  const httpRouting = worker.routingMode === 'http';

  // Attaching global-oidc@file to a router whose worker has no such middleware
  // makes Traefik drop the router outright — the app 404s instead of asking for
  // a login.  Deploying without it would be worse: the app would silently come
  // back unauthenticated.  Refuse instead, and say what to do.
  if (!httpRouting && globalOidcConfigured && !worker.oidcAppliedAt) {
    return {
      success: false,
      message:
        `Global OIDC is enabled on worker "${worker.name}" but has not been pushed to its Traefik yet. ` +
        `Open the worker's Settings tab and click "Apply to Traefik", then deploy again. ` +
        `Deploying now would either take the application offline or publish it without authentication.`,
      statusCode: 409,
    };
  }

  const globalOidcEnabled = globalOidcConfigured;

  // The Traefik OIDC plugin matches claim values by exact string equality, so
  // there is no way to express "any address at this domain". Fail rather than
  // deploy an app whose access restriction has quietly evaporated.
  if (app.authType === 'oidc' && app.authConfig) {
    try {
      const cfg = JSON.parse(app.authConfig);
      if (Array.isArray(cfg.allowedUserDomains) && cfg.allowedUserDomains.length > 0) {
        return { success: false, message: ALLOWED_DOMAINS_UNSUPPORTED, statusCode: 400 };
      }
    } catch {
      // buildMiddlewareOpts reports malformed auth config separately.
    }
  }

  if (!app.manifest) {
    return { success: false, message: 'No manifest found', statusCode: 400 };
  }

  // ── Record deployment ──────────────────────────────────
  const lastDeployment = await db.select({ version: deployments.version })
    .from(deployments)
    .where(eq(deployments.applicationId, app.id))
    .orderBy(desc(deployments.version))
    .limit(1)
    .get();
  const nextVersion = (lastDeployment?.version ?? 0) + 1;

  let deployImage: string | null = null;
  try {
    const parsed = JSON.parse(app.manifest);
    deployImage = parsed.image || null;
  } catch {
    deployImage = app.manifest;
  }

  // Digests recorded by the deployment being restored, if this is a rollback.
  // Empty for an ordinary deploy, which pins nothing and resolves tags fresh.
  const requestedDigests = parseDigestRecord(options.pinnedDigests);
  // Filled in as containers are created, then written back to this deployment
  // row so the next rollback has something to pin to.
  const deployedDigests = new Map<string, string>();

  const deploymentId = crypto.randomUUID();
  await db.insert(deployments).values({
    id: deploymentId,
    applicationId: app.id,
    version: nextVersion,
    manifest: app.manifest,
    environment: app.environment,
    volumes: app.volumes,
    image: deployImage,
    status: 'pending',
    deployedBy: deployedByUserId,
    createdAt: new Date(),
  });

  try {
    const podmanClient = getRestPodmanClient(worker);

    // Resolve SSH config once; used for post-teardown Netavark cleanup
    const workerSSHConfig = await resolveWorkerSSHConfig(worker);

    // ── Clean up existing containers before redeploy ──────────
    const existingContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();

    // Disconnect old containers from their network, then remove it.
    // Pass workerSSHConfig so teardownAppNetwork can run the Netavark iptables
    // cleanup over SSH immediately after the network is deleted, preventing
    // stale DNAT rules from shadowing the new container's port bindings.
    const oldContainerIds = existingContainers.map(c => c.containerId);
    try {
      await teardownAppNetwork(podmanClient, app.id, app.stackId, oldContainerIds, workerSSHConfig);
    } catch (e: any) {
      console.warn('Failed to teardown old network:', e.message);
    }

    for (const existing of existingContainers) {
      try {
        await podmanClient.removeContainer(existing.containerId, true);
      } catch (e: any) {
        console.warn(`Failed to remove old container ${existing.containerId}:`, e.message);
      }
      await db.delete(containers).where(eq(containers.id, existing.id));
    }

    let teamSlug: string | undefined;
    let team: typeof teams.$inferSelect | undefined;
    if (app.teamId) {
      team = await db.select().from(teams).where(eq(teams.id, app.teamId)).get();
      if (team) teamSlug = team.slug;
    }

    let stack: typeof stacks.$inferSelect | undefined;
    if (app.stackId) {
      stack = await db.select().from(stacks).where(eq(stacks.id, app.stackId)).get();
    }

    if (app.type === 'compose') {
      const validation = validateCompose(app.manifest);
      if (!validation.valid) {
        return { success: false, message: validation.errors.join(', '), statusCode: 400 };
      }

      const baseDomain = process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname;

      // Same collision-checked allocator the single-container path uses. Compose
      // previously drew host ports at random with no check, so two services in
      // one file could be handed the same port.
      const composeTakenPorts = await reservedPortsForWorker(worker.id, app.id);
      const parsedContainers = parseCompose(app.manifest, {
        appName: app.name,
        teamSlug,
        baseDomain,
        appId: app.id,
        team: team ? { name: team.name, id: team.id } : undefined,
        stack: stack ? { name: stack.name, id: stack.id } : undefined,
        globalOidcEnabled,
        appDomain: app.domain,
        emitTraefikLabels: !httpRouting,
        allocatePort: () => {
          const port = pickFreePort(composeTakenPorts);
          composeTakenPorts.add(port);
          return port;
        },
      });

      // Create isolated network for this app/stack
      const networkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);

      const composeSecrets = await resolveSecrets(app.teamId);
      const composeSecretEnvVars = composeSecrets.env;

      for (const container of parsedContainers) {
        try {
          // Keyed by compose service name so a rollback pins each service to
          // the bytes it ran, not merely to the first image in the file.
          const digestKey = container.labels['service'] ?? container.name;
          const composeImage = pinnedImageFor(digestKey, requestedDigests, container.image);

          const containerKeys = new Set(container.env.map((e: string) => e.split('=')[0]));
          const mergedContainerEnv = [
            ...composeSecretEnvVars.filter(s => !containerKeys.has(s.split('=')[0])),
            ...container.env,
          ];

          const binds = Object.entries(container.volumes)
            .filter(([hostPath]) => hostPath)
            .map(([hostPath, v]) => buildHostBind(hostPath, v.bind, v.options));

          const containerResult = await podmanClient.createContainer({
            name: container.name,
            image: composeImage,
            env: mergedContainerEnv,
            ports: container.ports,
            labels: container.labels,
            restartPolicy: container.restartPolicy,
            command: container.command,
            entrypoint: container.entrypoint,
            workingDir: container.workingDir,
            binds: binds.length > 0 ? binds : undefined,
            memory: container.memory,
            cpuQuota: container.cpuShares ? container.cpuShares * 100 : undefined,
            cpuPeriod: container.cpuShares ? 100000 : undefined,
            healthcheck: container.healthcheck,
            networkMode: networkName,
            networkAliases: container.labels['service'] ? [container.labels['service']] : undefined,
            tmpfs: composeSecrets.files.length > 0
              ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
              : undefined,
          });

          await deliverSecretFiles(podmanClient, containerResult.Id, composeSecrets.files);

          // Resolved after createContainer, which pulls: this is the digest of
          // what is about to run, not of a stale local copy.
          const composeDigest = await podmanClient.resolveImageDigest(composeImage);
          if (composeDigest) deployedDigests.set(digestKey, composeDigest);

          await db.insert(containers).values({
            id: crypto.randomUUID(),
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: container.name,
            image: composeImage,
            status: 'created',
            exposedPort: container.exposedPort ?? null,
            domain: container.domain ?? null,
            routerName: container.routerName ?? null,
            labels: JSON.stringify(redactSecretLabels(container.labels)),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await podmanClient.startContainer(containerResult.Id);
          await db.update(containers)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(containers.containerId, containerResult.Id));
        } catch (e: any) {
          console.error(`Failed to create container ${container.name}:`, e);
          throw new Error(`Container '${container.name}' failed to deploy: ${e.message}`);
        }
      }
    } else if (app.type === 'single') {
      let cfg: {
        image: string;
        command?: string;
        workingDir?: string;
        memoryLimit?: string;
        cpuLimit?: string;
        ports?: Array<{ containerPort: string; hostPort: string; protocol: string }>;
      };

      try {
        cfg = JSON.parse(app.manifest);
        if (!cfg.image) throw new Error('no image');
      } catch {
        cfg = { image: app.manifest };
      }

      // Git-based builds required an SSH key held server-side; that was removed
      // when keys moved to the browser vault, so the feature no longer exists.
      // Fail with a clear message instead of a generic build error.
      if (app.gitRepo) {
        return {
          success: false,
          message:
            'Git-based builds are no longer supported — SSH keys are not stored server-side. ' +
            'Build the image in CI and deploy it by tag instead.',
          statusCode: 400,
        };
      }

      const appSecrets = await resolveSecrets(app.teamId);
      const secretEnvVars = appSecrets.env;

      let envArray: string[] = [];
      if (app.environment) {
        try {
          const envVars: Array<{ key: string; value: string }> = JSON.parse(app.environment);
          envArray = envVars
            .filter((e) => e.key.trim())
            .map((e) => `${e.key}=${e.value}`);
        } catch {
          // ignore
        }
      }

      const userKeys = new Set(envArray.map(e => e.split('=')[0]));
      const mergedEnv = [
        ...secretEnvVars.filter(s => !userKeys.has(s.split('=')[0])),
        ...envArray,
      ];
      envArray = mergedEnv;

      let binds: string[] = [];
      if (app.volumes) {
        try {
          const vols: Array<{ hostPath: string; containerPath: string; mode: string; volumeId?: string }> =
            JSON.parse(app.volumes);

          const volumeIds = vols.filter((v) => v.volumeId).map((v) => v.volumeId!);
          const volumeMap = new Map<string, { name: string; containerPath: string }>();
          if (volumeIds.length > 0) {
            const registeredVolumes = await db
              .select()
              .from(volumes)
              .where(inArray(volumes.id, volumeIds))
              .all();
            for (const rv of registeredVolumes) {
              volumeMap.set(rv.id, { name: rv.name, containerPath: rv.containerPath });
            }
          }

          binds = vols
            .map((v) => {
              if (v.volumeId) {
                const rv = volumeMap.get(v.volumeId);
                if (!rv) return null;
                return `rudder-${app.id.slice(0, 8)}-${rv.name}:${rv.containerPath}:${v.mode || 'rw'}`;
              }
              if (!v.hostPath || !v.containerPath) return null;
              return buildHostBind(v.hostPath, v.containerPath, v.mode);
            })
            .filter((b): b is string => b !== null);
        } catch (e) {
          // A rejected mount must fail the deploy — never silently drop it,
          // which would start the container without its expected storage.
          if (e instanceof MountPolicyError) throw e;
          // Malformed JSON: no volumes to mount.
        }
      }

      const baseDomain = process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname;
      const appDomain = app.domain || buildAppDomain(app.name, baseDomain) || app.name;
      const middlewareOpts = buildMiddlewareOpts(app);
      const memBytes = cfg.memoryLimit ? parseMemory(cfg.memoryLimit) : undefined;
      const cpuCfg = cfg.cpuLimit ? parseCpu(cfg.cpuLimit) : undefined;
      const healthcheck = parseHealthcheck(app.healthcheck);

      const command = cfg.command?.trim()
        ? cfg.command.trim().split(/\s+/)
        : undefined;

      const replicaCount = Math.max(1, Math.min(10, app.replicas ?? 1));
      const safeName = routerName(app.name);

      // One image, so the digest record is a bare reference. On a rollback this
      // is the digest the old deployment ran; otherwise it is the tag and the
      // digest gets resolved after the pull below.
      const singleImage = pinnedImageFor(SINGLE_IMAGE_KEY, requestedDigests, cfg.image);

      // Create isolated network for this app
      const networkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);

      // Collect all replica ports for Traefik service URLs
      const replicaPorts: number[] = [];

      // Ports already taken on this worker, so a fresh allocation cannot land
      // on one.  Previously each port was an unchecked random draw, which
      // collided silently once a worker held a few dozen containers.
      const takenPorts = await reservedPortsForWorker(worker.id, app.id);
      const allocatePort = () => {
        const port = pickFreePort(takenPorts);
        takenPorts.add(port);
        return port;
      };

      for (let replicaIdx = 1; replicaIdx <= replicaCount; replicaIdx++) {
        const containerName = replicaCount > 1 ? `${app.name}-${app.id.slice(0, 8)}-${replicaIdx}` : `${app.name}-${app.id.slice(0, 8)}`;

        // Each replica gets its own random host port(s)
        const portBindings: Record<string, Array<{ hostPort: string }>> = {};
        let mainExposedPort: number | null = null;

        if (cfg.ports && cfg.ports.length > 0) {
          for (const p of cfg.ports) {
            if (!p.containerPort) continue;
            const proto = p.protocol || 'tcp';
            const key = `${p.containerPort}/${proto}`;
            // For replicas, always assign fresh ports to avoid collisions
            const hostPort = (replicaCount > 1 || !p.hostPort?.trim())
              ? String(allocatePort())
              : p.hostPort.trim();
            portBindings[key] = [{ hostPort }];
            if (!mainExposedPort) mainExposedPort = parseInt(hostPort);
          }
        } else {
          const exposedPort = allocatePort();
          portBindings['80/tcp'] = [{ hostPort: String(exposedPort) }];
          mainExposedPort = exposedPort;
        }

        if (mainExposedPort) replicaPorts.push(mainExposedPort);

        // For single replica, use standard labels; for multi-replica, all get the same
        // service name so Traefik merges them as multiple servers for load balancing.
        // Only the first replica gets the router labels. All replicas define their own
        // loadbalancer.server.url pointing to their own port.
        const labels: Record<string, string> = { app: app.name };
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

        if (httpRouting) {
          // Routing is served from the control plane, generated from the
          // domain/router/port columns written below. Only identity labels here.
          labels['rudder.managed'] = 'true';
        } else if (replicaCount === 1) {
          // Standard single-container: full Traefik labels
          const traefikLabels = generateTraefikLabelsForApp(app.name, appDomain, mainExposedPort ?? 80, true, middlewareOpts, globalOidcEnabled);
          Object.assign(labels, traefikLabels);
        } else {
          // Multi-replica: each container advertises its own server URL under the same service name.
          // The first replica also gets the router/middleware labels.
          labels['traefik.enable'] = 'true';
          labels[`traefik.http.services.${safeName}.loadbalancer.server.url`] = `http://127.0.0.1:${mainExposedPort}`;

          if (replicaIdx === 1) {
            // First replica carries router + middleware definitions
            const traefikLabels = generateTraefikLabelsForApp(app.name, appDomain, mainExposedPort ?? 80, true, middlewareOpts, globalOidcEnabled);
            Object.assign(labels, traefikLabels);
          }
        }

        const containerResult = await podmanClient.createContainer({
          name: containerName,
          image: singleImage,
          env: envArray,
          ports: Object.keys(portBindings).length > 0 ? portBindings : undefined,
          labels,
          restartPolicy: app.restartPolicy || 'always',
          command,
          workingDir: cfg.workingDir || undefined,
          binds: binds.length > 0 ? binds : undefined,
          memory: memBytes,
          cpuQuota: cpuCfg?.cpuQuota,
          cpuPeriod: cpuCfg?.cpuPeriod,
          healthcheck,
          networkMode: networkName,
          tmpfs: appSecrets.files.length > 0
            ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
            : undefined,
        });

        await deliverSecretFiles(podmanClient, containerResult.Id, appSecrets.files);

        if (!deployedDigests.has(SINGLE_IMAGE_KEY)) {
          const digest = await podmanClient.resolveImageDigest(singleImage);
          if (digest) deployedDigests.set(SINGLE_IMAGE_KEY, digest);
        }

        await db.insert(containers).values({
          id: crypto.randomUUID(),
          applicationId: app.id,
          workerId: worker.id,
          containerId: containerResult.Id,
          name: containerName,
          image: singleImage,
          status: 'created',
          exposedPort: mainExposedPort,
          domain: appDomain,
          routerName: safeName,
          labels: JSON.stringify(redactSecretLabels(labels)),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await podmanClient.startContainer(containerResult.Id);

        await db.update(containers)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(containers.containerId, containerResult.Id));
      }
    } else if (app.type === 'k8s') {
      const validation = validateK8sManifest(app.manifest);
      if (!validation.valid) {
        return { success: false, message: validation.errors.join(', '), statusCode: 400 };
      }

      const baseDomain = process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname;
      const parsedContainers = parseK8sManifest(app.manifest, app.name, teamSlug);

      // Create isolated network for this app
      const k8sNetworkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);

      const k8sSecrets = await resolveSecrets(app.teamId);
      const k8sSecretEnvVars = k8sSecrets.env;

      // The first container that exposes a port owns the application hostname;
      // any further exposed container is disambiguated as <app>-<container>.
      // Previously every container reused `app.domain`, producing several
      // Traefik routers with an identical Host rule and arbitrary routing.
      let primaryRouteTaken = false;

      for (const container of parsedContainers) {
        try {
          const k8sImage = pinnedImageFor(container.name, requestedDigests, container.image);

          let labels: Record<string, string> = { ...container.labels, app: app.name };
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

          const portKeys = Object.keys(container.ports);
          let k8sDomain: string | null = null;
          let k8sRouter: string | null = null;
          let k8sPort: number | null = null;
          if (portKeys.length > 0) {
            const firstPort = portKeys[0];
            // parseK8sManifest publishes hostPort = containerPort, so the key
            // is the host port too.
            k8sPort = parseInt(firstPort.split('/')[0]);
            const isPrimary = !primaryRouteTaken;
            primaryRouteTaken = true;
            k8sDomain = isPrimary
              ? (app.domain || buildAppDomain(app.name, baseDomain) || app.name)
              : (buildServiceDomain(app.name, container.name, baseDomain) || container.name);
            k8sRouter = isPrimary ? routerName(app.name) : routerName(app.name, container.name);
            if (httpRouting) {
              labels['rudder.managed'] = 'true';
            } else {
              const k8sMiddlewareOpts = buildMiddlewareOpts(app);
              const traefikLabels = generateTraefikLabelsForApp(k8sRouter, k8sDomain, k8sPort, true, k8sMiddlewareOpts, globalOidcEnabled);
              labels = { ...labels, ...traefikLabels };
            }
          }

          const k8sEnv = Object.entries(container.env).map(([k, v]) => `${k}=${v}`);
          const k8sKeys = new Set(Object.keys(container.env));
          const mergedK8sEnv = [
            ...k8sSecretEnvVars.filter(s => !k8sKeys.has(s.split('=')[0])),
            ...k8sEnv,
          ];

          // Build volume binds from parsed K8s volumes
          const k8sBinds = Object.entries(container.volumes)
            .filter(([hostPath]) => hostPath)
            .map(([hostPath, v]) => buildHostBind(hostPath, v.bind, v.options));

          const containerResult = await podmanClient.createContainer({
            name: `${app.name}-${app.id.slice(0, 8)}-${container.name}`,
            image: k8sImage,
            env: mergedK8sEnv,
            ports: Object.keys(container.ports).length > 0 ? container.ports : undefined,
            labels,
            restartPolicy: container.restartPolicy || app.restartPolicy || 'always',
            command: container.command,
            workingDir: container.workingDir,
            memory: container.memory,
            cpuQuota: container.cpuShares ? container.cpuShares * 100 : undefined,
            cpuPeriod: container.cpuShares ? 100000 : undefined,
            binds: k8sBinds.length > 0 ? k8sBinds : undefined,
            networkMode: k8sNetworkName,
            tmpfs: k8sSecrets.files.length > 0
              ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
              : undefined,
          });

          await deliverSecretFiles(podmanClient, containerResult.Id, k8sSecrets.files);

          const k8sDigest = await podmanClient.resolveImageDigest(k8sImage);
          if (k8sDigest) deployedDigests.set(container.name, k8sDigest);

          await db.insert(containers).values({
            id: crypto.randomUUID(),
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: `${app.name}-${container.name}`,
            image: k8sImage,
            status: 'created',
            exposedPort: k8sPort,
            domain: k8sDomain,
            routerName: k8sRouter,
            labels: JSON.stringify(redactSecretLabels(labels)),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await podmanClient.startContainer(containerResult.Id);

          await db.update(containers)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(containers.containerId, containerResult.Id));
        } catch (e: any) {
          console.error(`Failed to create container ${container.name}:`, e);
          throw new Error(`Container '${container.name}' failed to deploy: ${e.message}`);
        }
      }
    }

    await db.update(applications)
      .set({ updatedAt: new Date() })
      .where(eq(applications.id, applicationId));

    // Mark deployment as succeeded, recording what actually ran. Null when no
    // image reported a digest — an honest "unknown" that rollback falls back
    // from, rather than the tag masquerading as provenance.
    await db.update(deployments)
      .set({
        status: 'succeeded',
        imageDigest: serializeDigestRecord(deployedDigests),
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    return { success: true, message: 'Application deployed' };
  } catch (error: any) {
    console.error('Deployment error:', error);

    // Mark deployment as failed
    try {
      await db.update(deployments)
        .set({ status: 'failed', errorMessage: error.message, finishedAt: new Date() })
        .where(eq(deployments.id, deploymentId));
    } catch { /* best-effort */ }

    // A rejected mount is a manifest problem, not a server fault — report it
    // as a 400 with the policy message so the user can fix the definition.
    if (error instanceof MountPolicyError) {
      return { success: false, message: error.message, statusCode: 400 };
    }

    throw error;
  }
}
