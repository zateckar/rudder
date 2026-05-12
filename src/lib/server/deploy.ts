/**
 * Shared deploy logic — used by both the deploy API endpoint and the webhook trigger.
 */
import { db } from '$lib/db';
import { applications, workers, containers, teams, stacks, volumes, secrets, deployments } from '$lib/db/schema';
import { eq, inArray, or, desc } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { parseCompose, validateCompose } from '$lib/server/compose';
import { parseK8sManifest, validateK8sManifest } from '$lib/server/kubernetes';
import { generateTraefikLabelsForApp, type AppMiddlewareOptions } from '$lib/server/provisioning';
import { decrypt } from '$lib/server/encryption';
import { ensureAppNetwork, joinNetwork, connectTraefik, teardownAppNetwork } from '$lib/server/networks';
import { env } from '$lib/server/env';

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

/** Build middleware options from application DB record */
function buildMiddlewareOpts(app: any): AppMiddlewareOptions | undefined {
  const opts: AppMiddlewareOptions = {};
  let hasOpts = false;

  if (app.rateLimitAvg && app.rateLimitAvg > 0) {
    opts.rateLimitAvg = app.rateLimitAvg;
    opts.rateLimitBurst = app.rateLimitBurst || app.rateLimitAvg * 2;
    hasOpts = true;
  }

  if (app.authType === 'oidc' && app.authConfig) {
    try {
      opts.authType = 'oidc';
      opts.authConfig = JSON.parse(app.authConfig);
      hasOpts = true;
    } catch {
      // Invalid auth config, skip
    }
  }

  if (app.authType === 'none') {
    opts.authType = 'none';
    hasOpts = true;
  }

  // Extract health check path for Traefik routing
  if (app.healthcheck) {
    try {
      const hc = JSON.parse(app.healthcheck);
      const test = hc.test?.trim() || '';
      // Extract path from curl commands like "curl -f http://localhost:80/health"
      const curlMatch = test.match(/curl\s+.*https?:\/\/[^/]+(\/\S*)/);
      if (curlMatch) {
        opts.healthCheckPath = curlMatch[1].split(/\s+/)[0]; // strip trailing args
        hasOpts = true;
      }
    } catch { /* ignore */ }
  }

  return hasOpts ? opts : undefined;
}

/** Resolve secrets from the secrets store for deployment injection. */
async function resolveSecrets(teamId: string | null): Promise<string[]> {
  const conditions = [eq(secrets.scope, 'global')];
  if (teamId) {
    conditions.push(eq(secrets.teamId, teamId));
  }

  const rows = await db.select().from(secrets).where(or(...conditions)).all();

  return rows.map(s => {
    try {
      return `${s.name}=${decrypt(s.value)}`;
    } catch {
      return null;
    }
  }).filter((e): e is string => e !== null);
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

/** Parse CPU string like "0.5", "2" -> cpuQuota (period=100000) */
function parseCpu(cpu: string): { cpuQuota: number; cpuPeriod: number } | undefined {
  if (!cpu) return undefined;
  const val = parseFloat(cpu);
  if (isNaN(val) || val <= 0) return undefined;
  return { cpuQuota: Math.floor(val * 100000), cpuPeriod: 100000 };
}

/**
 * Build a container image on a worker from a Git repository via SSH.
 * Clones the repo, runs podman build, then cleans up the clone directory.
 */
async function buildImageFromGit(
  worker: typeof workers.$inferSelect,
  app: typeof applications.$inferSelect,
): Promise<string> {
  if (!app.gitRepo) throw new Error('No git repository configured');
  throw new Error('Git-based image builds via SSH are not supported. SSH keys are no longer stored server-side. Please use a pre-built Docker image instead.');
}

export interface DeployResult {
  success: boolean;
  message: string;
  error?: string;
  statusCode?: number;
}

/**
 * Resolve the SSH connection config for a worker, or return null when the
 * worker has no SSH key configured (e.g. local dev workers).
 * Used by deploy / delete paths to pass into teardownAppNetwork so the
 * Netavark stale-rule cleanup can be performed over SSH after network removal.
 */
export async function resolveWorkerSSHConfig(
  worker: typeof workers.$inferSelect,
): Promise<null> {
  // SSH keys are no longer stored server-side — always returns null
  return null;
}

/**
 * Execute a deploy for the given application.
 * @param applicationId - the application to deploy
 * @param deployedByUserId - the user who triggered the deploy (null for webhook triggers)
 */
export async function executeApplicationDeploy(
  applicationId: string,
  deployedByUserId: string | null = null,
): Promise<DeployResult> {
  const app = await db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!app) return { success: false, message: 'Application not found', statusCode: 404 };
  if (!app.workerId) return { success: false, message: 'No worker assigned to this application', statusCode: 400 };

  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) return { success: false, message: 'Worker not found', statusCode: 404 };

  const globalOidcEnabled = !!(worker.oidcEnabled && worker.oidcProviderUrl && worker.oidcClientId && worker.oidcClientSecret && worker.baseDomain);

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
      const parsedContainers = parseCompose(
        app.manifest,
        app.name,
        teamSlug,
        baseDomain,
        app.id,
        team ? { name: team.name, id: team.id } : undefined,
        stack ? { name: stack.name, id: stack.id } : undefined,
        globalOidcEnabled
      );

      // Create isolated network for this app/stack
      const networkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);

      const composeSecretEnvVars = await resolveSecrets(app.teamId);

      for (const container of parsedContainers) {
        try {
          const containerKeys = new Set(container.env.map((e: string) => e.split('=')[0]));
          const mergedContainerEnv = [
            ...composeSecretEnvVars.filter(s => !containerKeys.has(s.split('=')[0])),
            ...container.env,
          ];

          const binds = Object.entries(container.volumes)
            .filter(([hostPath]) => hostPath)
            .map(([hostPath, v]) => `${hostPath}:${v.bind}:${v.options}`);

          const containerResult = await podmanClient.createContainer({
            name: container.name,
            image: container.image,
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
          });

          await db.insert(containers).values({
            id: crypto.randomUUID(),
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: container.name,
            image: container.image,
            status: 'created',
            labels: JSON.stringify(container.labels),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          try {
            await joinNetwork(podmanClient, containerResult.Id, networkName);
            await connectTraefik(podmanClient, networkName);
          } catch (e) {
            console.warn(`Failed to connect ${container.name} to network:`, e);
          }

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

      // If this is a git-based app, build the image from source on the worker
      if (app.gitRepo) {
        const builtImage = await buildImageFromGit(worker, app);
        cfg.image = builtImage;
      }

      const secretEnvVars = await resolveSecrets(app.teamId);

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
              return `${v.hostPath}:${v.containerPath}:${v.mode || 'rw'}`;
            })
            .filter((b): b is string => b !== null);
        } catch {
          // ignore
        }
      }

      const baseDomain = process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname;
      const appDomain = app.domain || `${app.name}.${teamSlug ? teamSlug + '.' : ''}${baseDomain}`;
      const middlewareOpts = buildMiddlewareOpts(app);
      const memBytes = cfg.memoryLimit ? parseMemory(cfg.memoryLimit) : undefined;
      const cpuCfg = cfg.cpuLimit ? parseCpu(cfg.cpuLimit) : undefined;
      const healthcheck = parseHealthcheck(app.healthcheck);

      const command = cfg.command?.trim()
        ? cfg.command.trim().split(/\s+/)
        : undefined;

      const replicaCount = Math.max(1, Math.min(10, app.replicas ?? 1));
      const safeName = app.name.replace(/[^a-zA-Z0-9-]/g, '-');

      // Create isolated network for this app
      const networkName = await ensureAppNetwork(podmanClient, app.id, app.stackId);

      // Collect all replica ports for Traefik service URLs
      const replicaPorts: number[] = [];

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
            // For replicas, always assign random ports to avoid collisions
            const hostPort = (replicaCount > 1 || !p.hostPort?.trim())
              ? String(30000 + Math.floor(Math.random() * 10000))
              : p.hostPort.trim();
            portBindings[key] = [{ hostPort }];
            if (!mainExposedPort) mainExposedPort = parseInt(hostPort);
          }
        } else {
          const exposedPort = 30000 + Math.floor(Math.random() * 10000);
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

        if (replicaCount === 1) {
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
          image: cfg.image,
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
        });

        await db.insert(containers).values({
          id: crypto.randomUUID(),
          applicationId: app.id,
          workerId: worker.id,
          containerId: containerResult.Id,
          name: containerName,
          image: cfg.image,
          status: 'created',
          exposedPort: mainExposedPort,
          labels: JSON.stringify(labels),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await podmanClient.startContainer(containerResult.Id);

        // Connect to per-app network for inter-container communication
        try {
          await joinNetwork(podmanClient, containerResult.Id, networkName);
          await connectTraefik(podmanClient, networkName);
        } catch (e: any) {
          console.warn(`Failed to connect ${containerName} to network:`, e.message);
        }

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

      const k8sSecretEnvVars = await resolveSecrets(app.teamId);

      for (const container of parsedContainers) {
        try {
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
          if (portKeys.length > 0) {
            const firstPort = portKeys[0];
            const portNum = parseInt(firstPort.split('/')[0]);
            const appDomain = app.domain || `${container.name}.${baseDomain}`;
            const k8sMiddlewareOpts = buildMiddlewareOpts(app);
            const traefikLabels = generateTraefikLabelsForApp(container.name, appDomain, portNum, true, k8sMiddlewareOpts, globalOidcEnabled);
            labels = { ...labels, ...traefikLabels };
          }

          const k8sEnv = Object.entries(container.env).map(([k, v]) => `${k}=${v}`);
          const k8sKeys = new Set(Object.keys(container.env));
          const mergedK8sEnv = [
            ...k8sSecretEnvVars.filter(s => !k8sKeys.has(s.split('=')[0])),
            ...k8sEnv,
          ];

          const containerResult = await podmanClient.createContainer({
            name: `${app.name}-${app.id.slice(0, 8)}-${container.name}`,
            image: container.image,
            env: mergedK8sEnv,
            ports: Object.keys(container.ports).length > 0 ? container.ports : undefined,
            labels,
            restartPolicy: container.restartPolicy || app.restartPolicy || 'always',
            command: container.command,
            workingDir: container.workingDir,
            memory: container.memory,
            cpuQuota: container.cpuShares ? container.cpuShares * 100 : undefined,
            cpuPeriod: container.cpuShares ? 100000 : undefined,
            networkMode: k8sNetworkName,
          });

          await db.insert(containers).values({
            id: crypto.randomUUID(),
            applicationId: app.id,
            workerId: worker.id,
            containerId: containerResult.Id,
            name: `${app.name}-${container.name}`,
            image: container.image,
            status: 'created',
            labels: JSON.stringify(labels),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await podmanClient.startContainer(containerResult.Id);

          // Connect to per-app network
          try {
            await joinNetwork(podmanClient, containerResult.Id, k8sNetworkName);
            await connectTraefik(podmanClient, k8sNetworkName);
          } catch (e: any) {
            console.warn(`Failed to connect k8s container to network:`, e.message);
          }

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

    // Mark deployment as succeeded
    await db.update(deployments)
      .set({ status: 'succeeded', finishedAt: new Date() })
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

    throw error;
  }
}
