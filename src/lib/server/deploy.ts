/**
 * Shared deploy logic — used by both the deploy API endpoint and the webhook trigger.
 */
import { db } from '$lib/db';
import { applications, workers, containers, teams, stacks, volumes, secrets, deployments } from '$lib/db/schema';
import { and, eq, inArray, ne, or, desc } from 'drizzle-orm';
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
import {
  ALIAS_LABEL,
  ensureAppNetwork,
  networkAliases,
  teardownAppNetwork,
} from '$lib/server/networks';
import { env } from '$lib/server/env';
import { buildHostBind, MountPolicyError } from '$lib/server/mounts';
import {
  SINGLE_IMAGE_KEY,
  parseDigestRecord,
  pinnedImageFor,
  serializeDigestRecord,
} from '$lib/server/image-digests';
import { buildTar, MAX_TAR_NAME } from '$lib/server/tar';
import { pickFreePort } from '$lib/server/ports';
// Traefik needs the OIDC client secret in the container's labels; Rudder's own
// database does not, and used to keep a plaintext copy of it there.
import { redactSecretLabels } from '$lib/server/redaction';
import {
  CONVERGENCE_POLL_MS,
  CUTOVER_CONVERGENCE_TIMEOUT_MS,
  DRAIN_GRACE_MS,
  HEALTH_POLL_MS,
  SETTLE_MS,
  TRAEFIK_RELOAD_MARGIN_MS,
  declaresFixedHostPorts,
  generationalName,
  healthTimeoutMs,
  nextGeneration,
  retentionExpired,
  retentionMs,
  supportsBlueGreen,
} from '$lib/server/generations';

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

/**
 * Host ports already bound by containers on this worker.
 *
 * `excludeApplicationId` releases the ports held by the application being
 * redeployed, and is only correct on the legacy path, where those containers
 * are torn down earlier in the same deploy. A blue/green deploy must pass
 * nothing: the previous generation is still running on its ports, and reusing
 * one would collide the moment the new container tried to bind it.
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

// ── Network aliases ──────────────────────────────────────────────────────────

/**
 * Warn when another application on the same stack network already answers to a
 * name this deploy is about to claim.
 *
 * Not an error. A stack is a shared network by design, the collision may have
 * existed for months, and refusing the deploy would take a running application
 * down over a name nobody is necessarily using. What it must not do is happen
 * silently: `db` resolving to the wrong container is a debugging session that
 * starts nowhere near the network layer.
 *
 * The qualified `<app>-<key>` alias is unaffected, so there is always a name
 * that resolves unambiguously — the warning says so.
 */
async function warnOnAliasCollisions(
  app: typeof applications.$inferSelect,
  claimed: readonly string[],
): Promise<void> {
  if (!app.stackId || claimed.length === 0) return;

  const wanted = new Set(claimed);
  let neighbours: Array<{ appName: string; labels: string | null }>;
  try {
    neighbours = await db
      .select({ appName: applications.name, labels: containers.labels })
      .from(containers)
      .innerJoin(applications, eq(containers.applicationId, applications.id))
      .where(and(eq(applications.stackId, app.stackId), ne(applications.id, app.id)))
      .all();
  } catch (e: any) {
    console.warn('[deploy] Could not check for alias collisions:', e.message);
    return;
  }

  const reported = new Set<string>();
  for (const row of neighbours) {
    if (!row.labels) continue;
    let alias: unknown;
    try {
      alias = JSON.parse(row.labels)?.[ALIAS_LABEL];
    } catch {
      continue;
    }
    if (typeof alias !== 'string' || !wanted.has(alias)) continue;
    const key = `${alias}|${row.appName}`;
    if (reported.has(key)) continue;
    reported.add(key);
    console.warn(
      `[deploy] Application "${app.name}" and application "${row.appName}" both answer to ` +
      `"${alias}" on their shared stack network. Which one that name resolves to is not ` +
      `defined — use the qualified alias instead.`,
    );
  }
}

// ── Blue/green machinery ─────────────────────────────────────────────────────

type PodmanRestClient = ReturnType<typeof getRestPodmanClient>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A container this deploy created — enough to verify it, or to undo it. */
interface CreatedContainer {
  /** `containers.id`, the database row. */
  rowId: string;
  /** Podman's container id. */
  containerId: string;
  /** Podman's container name, for messages a human has to act on. */
  name: string;
}

/**
 * Wait until every container of the new generation is serving, or fail.
 *
 * Two signals, in order of strength:
 *
 * 1. **The container's own health check**, when the image or the application
 *    defines one. This is the real answer — the process said it is ready.
 * 2. **Still up after a settle window.** Weaker, and used only when there is no
 *    health check to consult.
 *
 * The plan for this work called for falling back to a TCP connect against the
 * mapped host port. That is not available to the control plane: published ports
 * are bound on the worker's loopback interface and the only thing Rudder can
 * reach on a worker is the mTLS Podman API. Probing them would need a helper on
 * the worker itself. Defining a health check on the application is the way to
 * get a real readiness signal today, and this is the honest fallback when there
 * is none.
 *
 * `RestartCount` is watched throughout, because `restart: always` turns a crash
 * loop into a container that is running again by the next poll.
 */
async function verifyGeneration(
  client: PodmanRestClient,
  created: CreatedContainer[],
  timeoutMs: number,
): Promise<void> {
  if (created.length === 0) return;

  const deadline = Date.now() + timeoutMs;
  const settledBy = Date.now() + SETTLE_MS;
  const baselineRestarts = new Map<string, number>();
  const waiting = new Map(created.map((c) => [c.containerId, c.name]));

  while (waiting.size > 0) {
    for (const [id, name] of [...waiting]) {
      let inspect;
      try {
        inspect = await client.getContainer(id);
      } catch (e: any) {
        throw new Error(`Container '${name}' vanished while starting: ${e.message}`);
      }

      const restarts = inspect.RestartCount ?? 0;
      const baseline = baselineRestarts.get(id);
      if (baseline === undefined) {
        baselineRestarts.set(id, restarts);
      } else if (restarts > baseline) {
        throw new Error(
          `Container '${name}' is restarting (${restarts} restarts) rather than staying up. ` +
          `Check its logs for why it exits.`,
        );
      }

      const state = inspect.State;
      if (!state.Running) {
        throw new Error(
          `Container '${name}' exited with code ${state.ExitCode} before it could serve traffic.`,
        );
      }

      const health = state.Health?.Status;
      if (health === 'unhealthy') {
        throw new Error(`Container '${name}' started but failed its health check.`);
      }
      if (health === 'healthy') {
        waiting.delete(id);
        continue;
      }
      // No health check defined: accept once it has simply stayed up.
      if (!health && Date.now() >= settledBy) {
        waiting.delete(id);
      }
    }

    if (waiting.size === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ` +
        `${[...waiting.values()].join(', ')} to report healthy. ` +
        `The previous version is still serving.`,
      );
    }
    await sleep(HEALTH_POLL_MS);
  }
}

/**
 * Remove containers this deploy created, and their rows.
 *
 * Best-effort by design: this runs while handling a failure, and a second
 * failure here must not replace the original error, which is the one that
 * explains what went wrong.
 */
async function discardGeneration(
  client: PodmanRestClient,
  created: CreatedContainer[],
): Promise<void> {
  for (const c of created) {
    try {
      await client.removeContainer(c.containerId, true);
    } catch (e: any) {
      console.warn(`[deploy] Could not remove abandoned container ${c.name}:`, e.message);
    }
    try {
      await db.delete(containers).where(eq(containers.id, c.rowId));
    } catch (e: any) {
      console.warn(`[deploy] Could not delete row for abandoned container ${c.name}:`, e.message);
    }
  }
}

/**
 * Block until the worker has fetched routing configuration written after
 * `since`, so the caller knows traffic has actually moved.
 *
 * Returns false on timeout. The caller continues anyway: the configuration is
 * correct in the database and the worker will converge on its next successful
 * poll. What must not happen is reaping the old generation while the worker is
 * still routing to it, so a false return suppresses the reap.
 */
async function waitForConfigConvergence(workerId: string, since: Date): Promise<boolean> {
  const deadline = Date.now() + CUTOVER_CONVERGENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await db
      .select({ fetchedAt: workers.configFetchedAt })
      .from(workers)
      .where(eq(workers.id, workerId))
      .get();
    if (row?.fetchedAt && row.fetchedAt.getTime() >= since.getTime()) {
      await sleep(TRAEFIK_RELOAD_MARGIN_MS);
      return true;
    }
    await sleep(CONVERGENCE_POLL_MS);
  }
  return false;
}

/** Stop and remove containers, and delete their rows. Releases their ports. */
async function reapContainers(
  client: PodmanRestClient,
  rows: Array<typeof containers.$inferSelect>,
): Promise<void> {
  for (const row of rows) {
    try {
      await client.removeContainer(row.containerId, true);
    } catch (e: any) {
      console.warn(`[deploy] Could not remove superseded container ${row.name}:`, e.message);
    }
    await db.delete(containers).where(eq(containers.id, row.id));
  }
}

/**
 * Remove draining generations whose retention window has passed.
 *
 * Called at the start of each deploy and from the metrics loop, so a retained
 * generation is cleaned up whether or not the application is deployed again.
 */
export async function sweepExpiredGenerations(): Promise<number> {
  const draining = await db
    .select({ container: containers, app: applications, worker: workers })
    .from(containers)
    .innerJoin(applications, eq(containers.applicationId, applications.id))
    .innerJoin(workers, eq(containers.workerId, workers.id))
    .where(eq(containers.state, 'draining'))
    .all();

  const now = new Date();
  let reaped = 0;
  const byWorker = new Map<string, { worker: typeof workers.$inferSelect; rows: Array<typeof containers.$inferSelect> }>();

  for (const row of draining) {
    if (!retentionExpired(row.app, row.container.updatedAt, now)) continue;
    const bucket = byWorker.get(row.worker.id) ?? { worker: row.worker, rows: [] };
    bucket.rows.push(row.container);
    byWorker.set(row.worker.id, bucket);
  }

  for (const { worker, rows } of byWorker.values()) {
    try {
      await reapContainers(getRestPodmanClient(worker), rows);
      reaped += rows.length;
    } catch (e: any) {
      console.warn(`[deploy] Sweep failed for worker ${worker.name}:`, e.message);
    }
  }
  return reaped;
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

  // Blue/green needs somewhere to express "this generation serves traffic and
  // that one does not" without recreating containers, which is exactly what
  // control-plane routing provides — so it turns on with the same per-worker
  // switch. A labels-mode worker keeps the destroy-then-create path.
  //
  // Applications that bind fixed host ports are excluded regardless of routing
  // mode — two generations cannot both hold the same port. Only a
  // single-container application can ask for one; compose and Kubernetes
  // manifests both have their host ports allocated.
  const blueGreen = supportsBlueGreen(worker) && !declaresFixedHostPorts(app);

  // Containers already deployed for this application. On the legacy path they
  // are removed before anything new is created; on the blue/green path they go
  // on serving until the new generation is verified.
  const existingContainers = await db
    .select()
    .from(containers)
    .where(eq(containers.applicationId, app.id))
    .all();

  const generation = nextGeneration(existingContainers.map((c) => c.generation));
  /** Only blue/green needs distinct names — see the module comment. */
  const nameFor = (base: string) => (blueGreen ? generationalName(base, generation) : base);
  /** New containers are invisible to the routing config until cutover. */
  const initialState = blueGreen ? 'pending' : 'active';
  /** Everything created by this deploy, so a failure can undo exactly it. */
  const createdContainers: CreatedContainer[] = [];

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

    if (blueGreen) {
      // Nothing is torn down here. The previous generation keeps serving until
      // the new one has proved it can, which is the whole point.
      //
      // The network is not touched either: both generations attach to the same
      // one. Recreating it between generations is what made the Netavark stale
      // DNAT rules bite, so not doing it removes that failure mode as well.
      //
      // What is cleaned up first is any generation left behind by an earlier
      // deploy's retention window, so its ports come back before this deploy
      // allocates.
      try {
        await sweepExpiredGenerations();
      } catch (e: any) {
        console.warn('[deploy] Could not sweep expired generations:', e.message);
      }
    } else {
      // ── Legacy path: clean up existing containers before redeploy ──────────
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
      const composeTakenPorts = await reservedPortsForWorker(
        worker.id,
        blueGreen ? undefined : app.id,
      );
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

      await warnOnAliasCollisions(app, parsedContainers.map((c) => c.aliases[0]));

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

          const composeName = nameFor(container.name);
          const containerResult = await podmanClient.createContainer({
            name: composeName,
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
            networkAliases: container.aliases,
            tmpfs: composeSecrets.files.length > 0
              ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
              : undefined,
          });

          await deliverSecretFiles(podmanClient, containerResult.Id, composeSecrets.files);

          // Resolved after createContainer, which pulls: this is the digest of
          // what is about to run, not of a stale local copy.
          const composeDigest = await podmanClient.resolveImageDigest(composeImage);
          if (composeDigest) deployedDigests.set(digestKey, composeDigest);

          const composeRowId = crypto.randomUUID();
          await db.insert(containers).values({
            id: composeRowId,
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: composeName,
            image: composeImage,
            status: 'created',
            // Every binding, not just the routed one: `reservedPortsForWorker`
            // reads this column, and a container's second published port has to
            // stay reserved too or a later deploy will be handed it.
            ports: Object.keys(container.ports).length > 0 ? JSON.stringify(container.ports) : null,
            exposedPort: container.exposedPort ?? null,
            domain: container.domain ?? null,
            routerName: container.routerName ?? null,
            labels: JSON.stringify(redactSecretLabels(container.labels)),
            generation,
            state: initialState,
            deploymentId,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          createdContainers.push({
            rowId: composeRowId,
            containerId: containerResult.Id,
            name: composeName,
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

      // Every replica shares the alias on purpose: Podman's DNS returns all the
      // addresses behind a name, so a sibling that resolves it round-robins
      // across the replicas rather than pinning to whichever came up first.
      const singleAliases = networkAliases(app.name, app.name);
      await warnOnAliasCollisions(app, [singleAliases[0]]);

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
      const takenPorts = await reservedPortsForWorker(
        worker.id,
        blueGreen ? undefined : app.id,
      );
      const allocatePort = () => {
        const port = pickFreePort(takenPorts);
        takenPorts.add(port);
        return port;
      };

      for (let replicaIdx = 1; replicaIdx <= replicaCount; replicaIdx++) {
        const containerName = nameFor(
          replicaCount > 1
            ? `${app.name}-${app.id.slice(0, 8)}-${replicaIdx}`
            : `${app.name}-${app.id.slice(0, 8)}`,
        );

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
        const labels: Record<string, string> = { app: app.name, [ALIAS_LABEL]: singleAliases[0] };
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
          networkAliases: singleAliases,
          tmpfs: appSecrets.files.length > 0
            ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
            : undefined,
        });

        await deliverSecretFiles(podmanClient, containerResult.Id, appSecrets.files);

        if (!deployedDigests.has(SINGLE_IMAGE_KEY)) {
          const digest = await podmanClient.resolveImageDigest(singleImage);
          if (digest) deployedDigests.set(SINGLE_IMAGE_KEY, digest);
        }

        const singleRowId = crypto.randomUUID();
        await db.insert(containers).values({
          id: singleRowId,
          applicationId: app.id,
          workerId: worker.id,
          containerId: containerResult.Id,
          name: containerName,
          image: singleImage,
          status: 'created',
          ports: Object.keys(portBindings).length > 0 ? JSON.stringify(portBindings) : null,
          exposedPort: mainExposedPort,
          domain: appDomain,
          routerName: safeName,
          labels: JSON.stringify(redactSecretLabels(labels)),
          generation,
          state: initialState,
          deploymentId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        createdContainers.push({
          rowId: singleRowId,
          containerId: containerResult.Id,
          name: containerName,
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

      // Same collision-checked allocator the other two paths use. A manifest's
      // `containerPort` used to become the host port verbatim, so two
      // applications both listening on 80 could not share a worker.
      const k8sTakenPorts = await reservedPortsForWorker(
        worker.id,
        blueGreen ? undefined : app.id,
      );
      const parsedContainers = parseK8sManifest(app.manifest, app.name, teamSlug, {
        allocatePort: () => {
          const port = pickFreePort(k8sTakenPorts);
          k8sTakenPorts.add(port);
          return port;
        },
      });

      await warnOnAliasCollisions(app, parsedContainers.map((c) => c.aliases[0]));

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
            // The binding's value, not its key: the key is the port inside the
            // container and the value is the host port Traefik has to reach.
            k8sPort = parseInt(container.ports[portKeys[0]][0].hostPort);
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

          const k8sContainerName = nameFor(`${app.name}-${app.id.slice(0, 8)}-${container.name}`);
          const containerResult = await podmanClient.createContainer({
            name: k8sContainerName,
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
            networkAliases: container.aliases,
            tmpfs: k8sSecrets.files.length > 0
              ? { [SECRETS_DIR]: SECRETS_TMPFS_OPTS }
              : undefined,
          });

          await deliverSecretFiles(podmanClient, containerResult.Id, k8sSecrets.files);

          const k8sDigest = await podmanClient.resolveImageDigest(k8sImage);
          if (k8sDigest) deployedDigests.set(container.name, k8sDigest);

          const k8sRowId = crypto.randomUUID();
          await db.insert(containers).values({
            id: k8sRowId,
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: `${app.name}-${container.name}`,
            image: k8sImage,
            status: 'created',
            ports: portKeys.length > 0 ? JSON.stringify(container.ports) : null,
            exposedPort: k8sPort,
            domain: k8sDomain,
            routerName: k8sRouter,
            labels: JSON.stringify(redactSecretLabels(labels)),
            generation,
            state: initialState,
            deploymentId,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          createdContainers.push({
            rowId: k8sRowId,
            containerId: containerResult.Id,
            name: k8sContainerName,
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

    if (blueGreen) {
      // ── Verify ────────────────────────────────────────────────────────────
      // Nothing routes to the new containers yet. A failure here throws, and
      // the catch below removes them; the previous generation never stopped.
      await verifyGeneration(podmanClient, createdContainers, healthTimeoutMs(app));

      // ── Cut over ──────────────────────────────────────────────────────────
      // One pair of updates moves the traffic. The worker's next fetch sees the
      // new servers and stops seeing the old ones — no container is recreated,
      // which is what makes the switch atomic from Traefik's point of view.
      const cutoverAt = new Date();
      const newRowIds = new Set(createdContainers.map((c) => c.rowId));
      // Re-read rather than reusing the pre-deploy snapshot: the sweep above
      // may already have removed a generation that was being retained, and
      // reaping a row that no longer exists would report failures that are not.
      const superseded = (
        await db.select().from(containers).where(eq(containers.applicationId, app.id)).all()
      ).filter((c) => !newRowIds.has(c.id));

      await db
        .update(containers)
        .set({ state: 'active', updatedAt: cutoverAt })
        .where(inArray(containers.id, [...newRowIds]));
      if (superseded.length > 0) {
        await db
          .update(containers)
          .set({ state: 'draining', updatedAt: cutoverAt })
          .where(inArray(containers.id, superseded.map((c) => c.id)));
      }

      // ── Reap ──────────────────────────────────────────────────────────────
      if (superseded.length > 0) {
        const converged = await waitForConfigConvergence(worker.id, cutoverAt);
        if (!converged) {
          // The worker has not fetched since the cutover, so its Traefik is
          // still working from the configuration that names the old
          // generation. Put that generation back into service rather than
          // reaping it: both versions then serve, which is untidy but keeps
          // the application up, where removing the one the worker is actually
          // routing to would take it down. The next deploy supersedes both.
          console.warn(
            `[deploy] Worker ${worker.name} did not fetch routing configuration within ` +
            `${Math.round(CUTOVER_CONVERGENCE_TIMEOUT_MS / 1000)}s of cutover; ` +
            `keeping generation ${superseded[0].generation} in service alongside ${generation}.`,
          );
          await db
            .update(containers)
            .set({ state: 'active', updatedAt: new Date() })
            .where(inArray(containers.id, superseded.map((c) => c.id)));
        } else {
          // Traffic is on the new generation. The old containers are still
          // finishing whatever they had in flight when the routing changed —
          // Traefik does not drain connections, so this wait is what protects
          // those requests.
          await sleep(DRAIN_GRACE_MS);

          if (retentionMs(app) > 0) {
            // Kept for a fast rollback: stopped, so it holds no CPU and serves
            // nothing, but present, so restarting it is seconds rather than a
            // pull and a recreate. Its ports stay reserved for the same reason.
            for (const old of superseded) {
              try {
                await podmanClient.stopContainer(old.containerId);
                await db
                  .update(containers)
                  .set({ status: 'stopped', updatedAt: new Date() })
                  .where(eq(containers.id, old.id));
              } catch (e: any) {
                console.warn(`[deploy] Could not stop retained container ${old.name}:`, e.message);
              }
            }
          } else {
            await reapContainers(podmanClient, superseded);
          }
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

    // Undo exactly what this deploy created. Only on the blue/green path: the
    // legacy path has already removed the previous generation, so tearing the
    // new one down would leave the application with nothing running at all,
    // where leaving the partial deploy in place at least keeps some of it up.
    if (blueGreen && createdContainers.length > 0) {
      try {
        await discardGeneration(getRestPodmanClient(worker), createdContainers);
      } catch (e: any) {
        console.warn('[deploy] Could not fully discard the failed generation:', e.message);
      }
    }

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

// ── Fast rollback ────────────────────────────────────────────────────────────

/**
 * Deployments whose containers are still on the worker, stopped, and can be
 * restarted instead of rebuilt.
 *
 * The application page uses this to say which entries in the history roll back
 * in seconds and which mean a full redeploy — a distinction that matters most
 * at exactly the moment nobody wants to discover it, so it is shown before the
 * user commits rather than implied by how long the button takes.
 */
export async function fastRollbackTargets(applicationId: string): Promise<string[]> {
  const rows = await db
    .select({ deploymentId: containers.deploymentId })
    .from(containers)
    .where(and(eq(containers.applicationId, applicationId), eq(containers.state, 'draining')))
    .all();
  return [...new Set(rows.map((r) => r.deploymentId).filter((d): d is string => !!d))];
}

/**
 * Restart a retained generation and move traffic back to it.
 *
 * No image is pulled and no container is created: the containers of that
 * deployment are still on the worker, stopped, holding the ports they were
 * given. Starting them and regenerating the routing configuration is the whole
 * operation, which is why it takes seconds.
 *
 * Returns a failure result rather than throwing when the retained generation is
 * not usable, so the caller can fall back to a full redeploy.
 */
export async function executeFastRollback(
  applicationId: string,
  targetDeploymentId: string,
): Promise<DeployResult> {
  const app = await db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!app?.workerId) return { success: false, message: 'Application not found', statusCode: 404 };

  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) return { success: false, message: 'Worker not found', statusCode: 404 };
  if (!supportsBlueGreen(worker)) {
    return { success: false, message: 'Worker does not use control-plane routing', statusCode: 409 };
  }

  const retained = await db
    .select()
    .from(containers)
    .where(
      and(
        eq(containers.applicationId, applicationId),
        eq(containers.deploymentId, targetDeploymentId),
        eq(containers.state, 'draining'),
      ),
    )
    .all();
  if (retained.length === 0) {
    return { success: false, message: 'That version is no longer on the worker', statusCode: 409 };
  }

  const current = await db
    .select()
    .from(containers)
    .where(and(eq(containers.applicationId, applicationId), eq(containers.state, 'active')))
    .all();

  const podmanClient = getRestPodmanClient(worker);
  const restarted: CreatedContainer[] = [];

  try {
    for (const row of retained) {
      await podmanClient.startContainer(row.containerId);
      await db
        .update(containers)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(containers.id, row.id));
      restarted.push({ rowId: row.id, containerId: row.containerId, name: row.name });
    }

    await verifyGeneration(podmanClient, restarted, healthTimeoutMs(app));
  } catch (error: any) {
    // Put it back the way it was. The current generation was never touched, so
    // the application is still serving whatever it was serving.
    for (const row of restarted) {
      try {
        await podmanClient.stopContainer(row.containerId);
        await db
          .update(containers)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(eq(containers.id, row.rowId));
      } catch { /* best-effort */ }
    }
    return {
      success: false,
      message: `The retained version did not come back up: ${error.message}`,
      statusCode: 500,
    };
  }

  const cutoverAt = new Date();
  await db
    .update(containers)
    .set({ state: 'active', updatedAt: cutoverAt })
    .where(inArray(containers.id, retained.map((c) => c.id)));
  if (current.length > 0) {
    await db
      .update(containers)
      .set({ state: 'draining', updatedAt: cutoverAt })
      .where(inArray(containers.id, current.map((c) => c.id)));
  }

  if (current.length > 0) {
    const converged = await waitForConfigConvergence(worker.id, cutoverAt);
    if (!converged) {
      // Same reasoning as a deploy that cannot confirm its cutover: keep both
      // generations serving rather than remove the one the worker is using.
      await db
        .update(containers)
        .set({ state: 'active', updatedAt: new Date() })
        .where(inArray(containers.id, current.map((c) => c.id)));
    } else {
      await sleep(DRAIN_GRACE_MS);
      if (retentionMs(app) > 0) {
        // Retained in turn, so rolling forward again is also fast.
        for (const row of current) {
          try {
            await podmanClient.stopContainer(row.containerId);
            await db
              .update(containers)
              .set({ status: 'stopped', updatedAt: new Date() })
              .where(eq(containers.id, row.id));
          } catch (e: any) {
            console.warn(`[rollback] Could not stop ${row.name}:`, e.message);
          }
        }
      } else {
        await reapContainers(podmanClient, current);
      }
    }
  }

  await db.update(applications).set({ updatedAt: new Date() }).where(eq(applications.id, applicationId));

  return { success: true, message: 'Rolled back to the retained version' };
}
