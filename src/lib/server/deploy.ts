/**
 * Shared deploy logic — used by both the deploy API endpoint and the webhook trigger.
 */
import { db } from '$lib/db';
import { applications, workers, containers, teams, stacks, volumes, secrets, deployments } from '$lib/db/schema';
import { and, eq, inArray, ne, or, desc } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import {
  ManifestError,
  type DeploymentPlan,
  type PlannedFile,
  type PlannedRoute,
} from '$lib/server/deploy/plan';
import { desiredState, type DesiredApp } from '$lib/server/reconcile';
import { generateTraefikLabelsForApp, type AppMiddlewareOptions } from '$lib/server/provisioning';
// Shared with the config generator so `labels` and `http` mode workers apply
// exactly the same rate limit, auth mode and health check.
import { buildMiddlewareOpts } from '$lib/server/traefik-config';
import { ALLOWED_DOMAINS_UNSUPPORTED } from '$lib/server/oidc';
import { decrypt } from '$lib/server/encryption';
import { ALIAS_LABEL, ensureAppNetwork, teardownAppNetwork } from '$lib/server/networks';
import { env } from '$lib/server/env';
import { MountPolicyError, realizeMounts, type MountIntent } from '$lib/server/mounts';
import {
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
 * Write a container's files in before it is started.
 *
 * Uploading before start is deliberate: Podman mounts the container's
 * filesystem to service the archive upload — tmpfs included — so the content is
 * in place the instant the entrypoint runs, with no window where the process is
 * up and its configuration is not.
 *
 * One archive per target directory, because that is what `putArchive` takes.
 */
async function deliverFiles(
  podmanClient: ReturnType<typeof getRestPodmanClient>,
  containerId: string,
  files: readonly PlannedFile[],
): Promise<void> {
  if (files.length === 0) return;

  const byDirectory = new Map<string, PlannedFile[]>();
  for (const file of files) {
    // The secrets API constrains names to /^[A-Z_][A-Z0-9_]*$/ and a ConfigMap
    // key has its own rules, but this is the point where a name becomes a path
    // inside a container, so it is checked again here rather than trusted. A
    // `../` in a name would write outside the target directory; an over-long
    // one would overflow the USTAR name field.
    const usable =
      /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(file.name) &&
      Buffer.byteLength(file.name) <= MAX_TAR_NAME;
    if (!usable) {
      console.error(`[deploy] Refusing to deliver a file with an unusable name: ${file.name}`);
      continue;
    }
    const bucket = byDirectory.get(file.dir) ?? [];
    bucket.push(file);
    byDirectory.set(file.dir, bucket);
  }

  for (const [dir, contents] of byDirectory) {
    const archive = buildTar(
      contents.map((f) => ({ name: f.name, content: f.content, mode: f.mode ?? 0o644 })),
    );
    await podmanClient.putArchive(containerId, dir, archive);
  }
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Traefik labels for a container's route.
 *
 * Only stamped on `labels`-mode workers. In `http` mode the routing config is
 * served from the control plane, generated from the domain/router/port columns
 * written alongside the container, and doing both would give Traefik two
 * routers with the same `Host()` rule.
 */
function routingLabels(
  route: PlannedRoute,
  middlewareOpts: AppMiddlewareOptions | undefined,
  globalOidcEnabled: boolean,
): Record<string, string> {
  if (!route.definesRouter) {
    // A replica. It advertises its own address under the shared service name so
    // Traefik load-balances across the set, and defines nothing else.
    return {
      'traefik.enable': 'true',
      [`traefik.http.services.${route.routerName}.loadbalancer.server.url`]:
        `http://127.0.0.1:${route.hostPort}`,
    };
  }
  return generateTraefikLabelsForApp(
    route.routerName,
    route.domain,
    route.hostPort,
    true, // WebSocket, for terminals
    middlewareOpts,
    globalOidcEnabled,
  );
}

// ── Volumes ──────────────────────────────────────────────────────────────────

/**
 * Look up the registered volumes an application references by id.
 *
 * Separated from building the mount intents so that part stays pure: the
 * registry is the only thing about a single-container application's storage
 * that is not in its own columns.
 */
async function resolveVolumeRegistry(
  raw: string | null | undefined,
): Promise<Map<string, { name: string; containerPath: string }>> {
  const registry = new Map<string, { name: string; containerPath: string }>();
  if (!raw) return registry;

  let referenced: string[] = [];
  try {
    const declared = JSON.parse(raw);
    if (Array.isArray(declared)) {
      referenced = declared
        .map((v: { volumeId?: string }) => v?.volumeId)
        .filter((id): id is string => !!id);
    }
  } catch {
    // Malformed JSON: nothing to look up, and nothing to mount.
  }
  if (referenced.length === 0) return registry;

  const rows = await db.select().from(volumes).where(inArray(volumes.id, referenced)).all();
  for (const row of rows) {
    registry.set(row.id, { name: row.name, containerPath: row.containerPath });
  }
  return registry;
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

// ── Mounts ───────────────────────────────────────────────────────────────────

/**
 * Turn a container's mount intents into the two arguments `createContainer`
 * takes, and add the secrets tmpfs when there are file-mode secrets to deliver.
 *
 * This is the only place the mount policy runs. Every format reaches it, so a
 * denied host path fails identically whether it came from a compose file, a
 * Kubernetes manifest or the application form.
 *
 * The secrets mount is applied last on purpose: a manifest that declares
 * storage at `/run/secrets` does not get to displace it.
 */
function containerMounts(
  intents: readonly MountIntent[],
  hasSecretFiles: boolean,
): { binds?: string[]; tmpfs?: Record<string, string> } {
  const { binds, tmpfs } = realizeMounts(intents);
  if (hasSecretFiles) tmpfs[SECRETS_DIR] = SECRETS_TMPFS_OPTS;
  return {
    binds: binds.length > 0 ? binds : undefined,
    tmpfs: Object.keys(tmpfs).length > 0 ? tmpfs : undefined,
  };
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

  let team: typeof teams.$inferSelect | undefined;
  if (app.teamId) {
    team = await db.select().from(teams).where(eq(teams.id, app.teamId)).get();
  }

  let stack: typeof stacks.$inferSelect | undefined;
  if (app.stackId) {
    stack = await db.select().from(stacks).where(eq(stacks.id, app.stackId)).get();
  }

  // ── Plan ────────────────────────────────────────────────────────────────
  // Built before the deployment row exists and before anything is torn down,
  // so a manifest Rudder will not deploy costs the application nothing.
  //
  // Ports already held on this worker are excluded from allocation. The
  // application's own are released only on the legacy path, where its
  // containers are removed later in this same deploy; a blue/green deploy
  // leaves the previous generation running on them.
  const takenPorts = await reservedPortsForWorker(worker.id, blueGreen ? undefined : app.id);

  // Intent comes from `desiredState`, which the reconciler also calls. Two
  // definitions of what should be running would eventually disagree, and the
  // disagreement would show up as a reconciler wanting to rebuild a fleet that
  // was already correct.
  const volumeRegistry = await resolveVolumeRegistry(app.volumes);

  let desired: DesiredApp;
  try {
    desired = desiredState({
      app,
      worker,
      team,
      stack,
      volumeRegistry,
      allocatePort: () => {
        const port = pickFreePort(takenPorts);
        takenPorts.add(port);
        return port;
      },
    });
    // Apply the mount policy now, and throw the result away. It is applied
    // again per container during creation, but by then the legacy path has
    // already removed the previous generation — so a denied host path would
    // take the application down before saying why.
    for (const { planned } of desired.containers) realizeMounts(planned.mounts);
  } catch (e: any) {
    // A manifest that cannot be deployed as written. Nothing has been created,
    // nothing torn down, and no deployment row records the attempt.
    if (e instanceof ManifestError || e instanceof MountPolicyError) {
      return { success: false, message: e.message, statusCode: 400 };
    }
    throw e;
  }

  const plan: DeploymentPlan = {
    containers: desired.containers.map((c) => c.planned),
    notes: desired.notes,
  };
  /** Recreation-forcing intent per container, stored so the reconciler can compare. */
  const specHashes = new Map(desired.containers.map((c) => [c.key, c.specHash]));

  await warnOnAliasCollisions(app, [...new Set(plan.containers.map((c) => c.aliases[0]))]);

  // ── Record deployment ──────────────────────────────────
  const lastDeployment = await db.select({ version: deployments.version })
    .from(deployments)
    .where(eq(deployments.applicationId, app.id))
    .orderBy(desc(deployments.version))
    .limit(1)
    .get();
  const nextVersion = (lastDeployment?.version ?? 0) + 1;

  // The plan's own answer, not a guess from the manifest column. Reading it
  // back out of the manifest meant a compose file that failed `JSON.parse` was
  // stored here whole — environment block, API keys and all — and shown in the
  // deployment history.
  const deployImage = plan.containers[0]?.image ?? null;

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
    // What this deploy did not do exactly as the manifest asked. Stored on the
    // row rather than logged, so it reaches the person who wrote the manifest.
    notes: plan.notes.length > 0 ? JSON.stringify(plan.notes) : null,
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

    // ── Execute ───────────────────────────────────────────────────────────
    // One loop, whatever the application was written as. Everything that used
    // to be repeated per format — secrets, digests, labels, rows, start —
    // happens here and only here.
    const networkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);
    const appSecrets = await resolveSecrets(app.teamId);
    const middlewareOpts = buildMiddlewareOpts(app);

    for (const planned of plan.containers) {
      try {
        const digestKey = planned.digestKey ?? planned.key;
        const image = pinnedImageFor(digestKey, requestedDigests, planned.image);

        // A value the manifest sets wins over a secret of the same name: the
        // manifest is the more specific statement of intent.
        const declared = new Set(planned.env.map((e) => e.split('=')[0]));
        const env = [
          ...appSecrets.env.filter((s) => !declared.has(s.split('=')[0])),
          ...planned.env,
        ];

        const labels = { ...planned.labels };
        if (planned.route && !httpRouting) {
          Object.assign(labels, routingLabels(planned.route, middlewareOpts, globalOidcEnabled));
        }

        const containerName = nameFor(planned.name);
        const files: PlannedFile[] = [
          ...(planned.files ?? []),
          ...appSecrets.files.map((f) => ({
            dir: SECRETS_DIR,
            name: f.name,
            content: f.value,
            mode: 0o400,
          })),
        ];

        const containerResult = await podmanClient.createContainer({
          name: containerName,
          image,
          env,
          ports: Object.keys(planned.ports).length > 0 ? planned.ports : undefined,
          labels,
          restartPolicy: planned.restartPolicy,
          command: planned.command,
          entrypoint: planned.entrypoint,
          workingDir: planned.workingDir,
          memory: planned.memory,
          cpuQuota: planned.cpuQuota,
          cpuPeriod: planned.cpuPeriod,
          healthcheck: planned.healthcheck,
          networkMode: networkName,
          networkAliases: planned.aliases,
          ...containerMounts(planned.mounts, appSecrets.files.length > 0),
        });

        await deliverFiles(podmanClient, containerResult.Id, files);

        // Resolved after createContainer, which pulls: this is the digest of
        // what is about to run, not of a stale local copy. Replicas share an
        // image, so it is resolved once.
        if (!deployedDigests.has(digestKey)) {
          const digest = await podmanClient.resolveImageDigest(image);
          if (digest) deployedDigests.set(digestKey, digest);
        }

        const rowId = crypto.randomUUID();
        await db.insert(containers).values({
          id: rowId,
          applicationId: app.id,
          workerId: worker.id,
          containerId: containerResult.Id,
          name: containerName,
          image,
          status: 'created',
          // Every binding, not just the routed one: `reservedPortsForWorker`
          // reads this column, and a container's second published port has to
          // stay reserved too or a later deploy will be handed it.
          ports: Object.keys(planned.ports).length > 0 ? JSON.stringify(planned.ports) : null,
          exposedPort: planned.route?.hostPort ?? null,
          domain: planned.route?.domain ?? null,
          routerName: planned.route?.routerName ?? null,
          labels: JSON.stringify(redactSecretLabels(labels)),
          generation,
          state: initialState,
          deploymentId,
          // What the reconciler compares against. Recorded from the plan that
          // produced this container, so a later pass computing the same intent
          // reads it as current without needing to inspect the container.
          specHash: specHashes.get(planned.key) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        createdContainers.push({
          rowId,
          containerId: containerResult.Id,
          name: containerName,
        });

        await podmanClient.startContainer(containerResult.Id);
        await db.update(containers)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(containers.id, rowId));
      } catch (e: any) {
        console.error(`Failed to create container ${planned.name}:`, e);
        // Keep the type: a mount the policy rejects is the user's to fix, and
        // wrapping it in a plain Error turned a 400 into a 500.
        const message = `Container '${planned.key}' failed to deploy: ${e.message}`;
        throw e instanceof MountPolicyError ? new MountPolicyError(message) : new Error(message);
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
