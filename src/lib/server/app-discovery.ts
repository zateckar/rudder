/**
 * Application Discovery Service
 *
 * Automatically discovers and imports existing containerized applications
 * during worker re-provisioning. Reconstructs team structure and application
 * configurations from container labels and inspection data.
 */

import { db } from '$lib/db';
import { applications, containers, teams, stacks, workers, deployments } from '$lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import type { Container, ContainerInspect } from '$lib/server/podman';
import { randomBytes } from 'crypto';
// A discovered container's labels can carry an OIDC client secret stamped in by
// a previous deploy; keep it out of Rudder's database.
import { redactSecretLabels } from '$lib/server/redaction';

interface ParsedTraefikConfig {
  domain: string | null;
  targetPort: number | null;
  healthCheckPath: string | null;
  rateLimitAvg: number | null;
  rateLimitBurst: number | null;
  authType: 'none' | 'oidc' | 'global';
  authConfig: any | null;
}

interface DiscoveredApp {
  id: string;
  teamId: string | null;
  workerId: string;
  name: string;
  description: string | null;
  domain: string | null;
  type: 'single';
  deploymentFormat: 'compose';
  manifest: string;
  environment: string | null;
  volumes: string | null;
  restartPolicy: 'no' | 'on-failure' | 'always' | 'unless-stopped';
  rateLimitAvg: number | null;
  rateLimitBurst: number | null;
  authType: 'none' | 'oidc' | 'global';
  authConfig: string | null;
  stackId: string | null;
  replicas: number;
  gitRepo: string | null;
  gitBranch: string | null;
  gitDockerfile: string | null;
  healthcheck: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  containerInfo: {
    containerId: string;
    name: string;
    image: string;
    status: string;
    labels: Record<string, string>;
  };
}

/**
 * Check if container is infrastructure (should not be imported as an app)
 */
function isInfrastructureContainer(container: Container): boolean {
  const infraNames = ['traefik', 'crowdsec', 'podman-api'];
  return infraNames.some(name =>
    container.Names.some(n => n.toLowerCase().includes(name.toLowerCase()))
  );
}

/**
 * Check if container is an application (has Traefik routing labels)
 */
function isApplicationContainer(container: Container): boolean {
  return Object.keys(container.Labels).some(key =>
    key.startsWith('traefik.http.routers.') && key.endsWith('.rule')
  );
}

/**
 * Parse Traefik labels to extract application configuration
 */
function parseTraefikLabels(labels: Record<string, string>): ParsedTraefikConfig {
  const config: ParsedTraefikConfig = {
    domain: null,
    targetPort: null,
    healthCheckPath: null,
    rateLimitAvg: null,
    rateLimitBurst: null,
    authType: 'none',
    authConfig: null,
  };

  // Extract domain from router rule
  for (const [key, value] of Object.entries(labels)) {
    if (key.includes('traefik.http.routers.') && key.endsWith('.rule')) {
      const domainMatch = value.match(/Host\(\`([^\`]+)\`\)/);
      if (domainMatch) {
        config.domain = domainMatch[1];
      }
    }

    // Extract target port from service URL
    if (key.includes('traefik.http.services.') && key.endsWith('.loadbalancer.server.url')) {
      const portMatch = value.match(/:(\d+)$/);
      if (portMatch) {
        config.targetPort = parseInt(portMatch[1]);
      }
    }

    // Extract health check path
    if (key.includes('.loadbalancer.healthcheck.path')) {
      config.healthCheckPath = value;
    }

    // Extract rate limiting
    if (key.includes('-ratelimit.ratelimit.average')) {
      config.rateLimitAvg = parseInt(value) || null;
    }
    if (key.includes('-ratelimit.ratelimit.burst')) {
      config.rateLimitBurst = parseInt(value) || null;
    }

    // Detect OIDC (but we can't recover secrets)
    if (key.includes('-oidc.plugin.traefik-oidc-auth.')) {
      config.authType = 'oidc';
      // Note: We can't recover clientSecret and sessionEncryptionKey from labels
      // so authConfig will remain null, requiring manual reconfiguration
    }
  }

  // Detect Global OIDC
  for (const [key, value] of Object.entries(labels)) {
    if (key.includes('traefik.http.routers.') && key.endsWith('.middlewares')) {
      if (value.includes('global-oidc@file')) {
        config.authType = 'global';
      }
    }
  }

  return config;
}

/**
 * Convert container inspection data to application schema
 */
function containerToApplication(
  container: ContainerInspect,
  workerId: string,
  teamId: string | null,
  stackId: string | null,
  userId: string | null
): DiscoveredApp {
  const traefikConfig = parseTraefikLabels(container.Config.Labels || {});

  // Parse environment variables
  const envVars = (container.Config.Env || [])
    .filter(e => !e.startsWith('PATH=') && !e.startsWith('HOME=')) // Filter out system vars
    .map(e => {
      const [key, ...valueParts] = e.split('=');
      return { key, value: valueParts.join('=') };
    });

  // Parse volumes
  const volumeBinds = (container.HostConfig?.Binds || []).map(bind => {
    const [hostPath, containerPath, mode = 'rw'] = bind.split(':');
    return { hostPath, containerPath, mode, volumeId: null };
  });

  // Map restart policy
  let restartPolicy: 'no' | 'on-failure' | 'always' | 'unless-stopped' = 'no';
  const policyName = container.HostConfig?.RestartPolicy?.Name;
  if (policyName === 'always' || policyName === 'on-failure' || policyName === 'unless-stopped') {
    restartPolicy = policyName;
  }

  // Extract app name from labels or container name
  const appName = container.Config.Labels?.['app'] || container.Name.replace(/^\//, '').split('-')[0];

  // Health check
  let healthcheck: string | null = null;
  if (traefikConfig.healthCheckPath) {
    healthcheck = JSON.stringify({
      test: `curl -f http://localhost${traefikConfig.healthCheckPath} || exit 1`,
      interval: 30,
      timeout: 10,
      retries: 3,
    });
  }

  const appId = crypto.randomUUID();

  return {
    id: appId,
    teamId,
    workerId,
    name: appName,
    description: `Discovered from existing container: ${container.Name}`,
    domain: traefikConfig.domain,
    type: 'single',
    deploymentFormat: 'compose',
    manifest: container.Config.Image,
    environment: envVars.length > 0 ? JSON.stringify(envVars) : null,
    volumes: volumeBinds.length > 0 ? JSON.stringify(volumeBinds) : null,
    restartPolicy,
    rateLimitAvg: traefikConfig.rateLimitAvg,
    rateLimitBurst: traefikConfig.rateLimitBurst,
    authType: traefikConfig.authType,
    authConfig: null, // OIDC secrets cannot be recovered
    stackId,
    replicas: 1,
    gitRepo: null,
    gitBranch: null,
    gitDockerfile: null,
    healthcheck,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    containerInfo: {
      containerId: container.Id,
      name: container.Name,
      image: container.Config.Image,
      status: container.State?.Status || 'unknown',
      labels: container.Config.Labels || {},
    },
  };
}

/**
 * Discover teams from container labels and create them if they don't exist
 */
async function discoverAndCreateTeams(
  containers: Container[],
  userId: string | null
): Promise<Map<string, string>> {
  const teamsMap = new Map<string, string>(); // slug -> teamId
  const uniqueTeams = new Map<string, { name: string; id: string }>();

  // Extract unique teams from container labels
  for (const container of containers) {
    const teamSlug = container.Labels['team'];
    const teamName = container.Labels['rudder.team.name'];
    const teamId = container.Labels['rudder.team.id'];

    if (teamSlug && teamName) {
      if (!uniqueTeams.has(teamSlug)) {
        uniqueTeams.set(teamSlug, {
          name: teamName,
          id: teamId || crypto.randomUUID(),
        });
      }
    }
  }

  // Create teams if they don't exist
  for (const [slug, { name, id }] of uniqueTeams) {
    const existing = await db.select()
      .from(teams)
      .where(eq(teams.slug, slug))
      .get();

    if (!existing) {
      await db.insert(teams).values({
        id,
        name,
        slug,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`[app-discovery] Created team: ${name} (${slug})`);
      teamsMap.set(slug, id);
    } else {
      teamsMap.set(slug, existing.id);
    }
  }

  return teamsMap;
}

/**
 * Discover stacks from container labels and create them if they don't exist
 */
async function discoverAndCreateStacks(
  containers: Container[],
  teamsMap: Map<string, string>,
  userId: string | null
): Promise<Map<string, string>> {
  const stacksMap = new Map<string, string>(); // stackId (from label) -> stackId (in DB)
  const uniqueStacks = new Map<string, { name: string; id: string; teamId: string | null }>();

  // Extract unique stacks from container labels
  for (const container of containers) {
    const stackName = container.Labels['rudder.stack.name'];
    const stackId = container.Labels['rudder.stack.id'];
    const teamSlug = container.Labels['team'];

    if (stackName && stackId) {
      if (!uniqueStacks.has(stackId)) {
        const teamId = teamSlug ? (teamsMap.get(teamSlug) || null) : null;
        uniqueStacks.set(stackId, {
          name: stackName,
          id: stackId,
          teamId,
        });
      }
    }
  }

  // Create stacks if they don't exist
  for (const [stackId, { name, id, teamId }] of uniqueStacks) {
    const existing = await db.select()
      .from(stacks)
      .where(eq(stacks.id, stackId))
      .get();

    if (!existing) {
      await db.insert(stacks).values({
        id,
        name,
        description: `Discovered stack from re-provisioning`,
        teamId,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`[app-discovery] Created stack: ${name} (team: ${teamId || 'none'})`);
      stacksMap.set(stackId, id);
    } else {
      stacksMap.set(stackId, existing.id);
    }
  }

  return stacksMap;
}

/**
 * Get or create default team for apps without team labels
 */
async function getOrCreateDefaultTeam(userId: string | null): Promise<string> {
  const defaultTeamName = 'Imported Applications';
  const defaultTeamSlug = 'imported-apps';

  let team = await db.select()
    .from(teams)
    .where(eq(teams.slug, defaultTeamSlug))
    .get();

  if (!team) {
    const teamId = crypto.randomUUID();
    await db.insert(teams).values({
      id: teamId,
      name: defaultTeamName,
      slug: defaultTeamSlug,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`[app-discovery] Created default team: ${defaultTeamName}`);
    return teamId;
  }

  return team.id;
}

/**
 * Main discovery function - discovers and imports applications from a worker
 */
export async function discoverApplicationsOnWorker(
  workerId: string,
  userId: string | null
): Promise<{ appsDiscovered: number; teamsCreated: number; stacksCreated: number }> {
  console.log(`[app-discovery] Starting discovery on worker ${workerId}`);

  // Get worker details
  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  // Connect to Podman API
  const podmanClient = getRestPodmanClient(worker);

  try {
    // List all containers
    const allContainers = await podmanClient.listContainers(true);
    console.log(`[app-discovery] Found ${allContainers.length} total containers`);

    // Filter out infrastructure containers
    const appContainers = allContainers.filter(c =>
      !isInfrastructureContainer(c) && isApplicationContainer(c)
    );
    console.log(`[app-discovery] Found ${appContainers.length} application containers`);

    if (appContainers.length === 0) {
      return { appsDiscovered: 0, teamsCreated: 0, stacksCreated: 0 };
    }

    // Discover and create teams
    const initialTeamCount = (await db.select().from(teams).all()).length;
    const teamsMap = await discoverAndCreateTeams(appContainers, userId);
    const defaultTeamId = await getOrCreateDefaultTeam(userId);
    const finalTeamCount = (await db.select().from(teams).all()).length;
    const teamsCreated = finalTeamCount - initialTeamCount;

    // Discover and create stacks
    const initialStackCount = (await db.select().from(stacks).all()).length;
    const stacksMap = await discoverAndCreateStacks(appContainers, teamsMap, userId);
    const finalStackCount = (await db.select().from(stacks).all()).length;
    const stacksCreated = finalStackCount - initialStackCount;

    // Process each application container
    let appsDiscovered = 0;
    for (const container of appContainers) {
      try {
        // Get full container details
        const containerDetails = await podmanClient.getContainer(container.Id);

        // Determine team assignment
        const teamSlug = container.Labels['team'];
        const teamId = teamSlug ? (teamsMap.get(teamSlug) || defaultTeamId) : defaultTeamId;

        // Determine stack assignment
        const stackLabelId = container.Labels['rudder.stack.id'];
        const stackId = stackLabelId ? (stacksMap.get(stackLabelId) || null) : null;

        // Convert to application
        const app = containerToApplication(containerDetails, workerId, teamId, stackId, userId);

        // Check for duplicates
        const existing = await db.select()
          .from(applications)
          .where(and(
            eq(applications.name, app.name),
            eq(applications.workerId, workerId)
          ))
          .get();

        if (existing) {
          // Get next deployment version
          const lastDep = await db.select({ version: deployments.version })
            .from(deployments)
            .where(eq(deployments.applicationId, existing.id))
            .orderBy(desc(deployments.version))
            .limit(1)
            .get();
          const nextVersion = (lastDep?.version ?? 0) + 1;

          // Record a new 'succeeded' deployment for the current state
          await db.insert(deployments).values({
            id: crypto.randomUUID(),
            applicationId: existing.id,
            version: nextVersion,
            manifest: existing.manifest,
            environment: existing.environment,
            volumes: existing.volumes,
            image: app.containerInfo.image,
            status: 'succeeded',
            deployedBy: userId,
            createdAt: new Date(),
            finishedAt: new Date(),
          });
          console.log(`[app-discovery] Added deployment record for existing app "${existing.name}" (v${nextVersion})`);

          // Update or insert container record with new ID
          const existingContainer = await db.select()
            .from(containers)
            .where(and(
              eq(containers.applicationId, existing.id),
              eq(containers.workerId, workerId)
            ))
            .get();

          if (existingContainer) {
            await db.update(containers)
              .set({
                containerId: app.containerInfo.containerId,
                name: app.containerInfo.name,
                image: app.containerInfo.image,
                status: app.containerInfo.status,
                labels: JSON.stringify(redactSecretLabels(app.containerInfo.labels)),
                updatedAt: new Date(),
              })
              .where(eq(containers.id, existingContainer.id));
          } else {
            await db.insert(containers).values({
              id: crypto.randomUUID(),
              applicationId: existing.id,
              workerId: workerId,
              containerId: app.containerInfo.containerId,
              name: app.containerInfo.name,
              image: app.containerInfo.image,
              status: app.containerInfo.status,
              labels: JSON.stringify(redactSecretLabels(app.containerInfo.labels)),
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }

          appsDiscovered++;
          continue;
        }

        // Log OIDC warning
        if (app.authType === 'oidc') {
          console.warn(
            `[app-discovery] Application "${app.name}" has OIDC authentication but secrets cannot be recovered. ` +
            `Manual reconfiguration required in UI.`
          );
        }

        // Insert application record
        await db.insert(applications).values({
          id: app.id,
          teamId: app.teamId,
          workerId: app.workerId,
          name: app.name,
          description: app.description,
          domain: app.domain,
          type: app.type,
          deploymentFormat: app.deploymentFormat,
          manifest: app.manifest,
          environment: app.environment,
          volumes: app.volumes,
          restartPolicy: app.restartPolicy,
          rateLimitAvg: app.rateLimitAvg,
          rateLimitBurst: app.rateLimitBurst,
          authType: app.authType,
          authConfig: app.authConfig,
          stackId: app.stackId,
          replicas: app.replicas,
          gitRepo: app.gitRepo,
          gitBranch: app.gitBranch,
          gitDockerfile: app.gitDockerfile,
          healthcheck: app.healthcheck,
          createdBy: app.createdBy,
          createdAt: app.createdAt,
          updatedAt: app.updatedAt,
        });

        // Record an initial 'succeeded' deployment — app is already running, no redeploy needed
        await db.insert(deployments).values({
          id: crypto.randomUUID(),
          applicationId: app.id,
          version: 1,
          manifest: app.manifest,
          environment: app.environment,
          volumes: app.volumes,
          image: app.containerInfo.image,
          status: 'succeeded',
          deployedBy: userId,
          createdAt: new Date(),
          finishedAt: new Date(),
        });

        // Insert container record
        await db.insert(containers).values({
          id: crypto.randomUUID(),
          applicationId: app.id,
          workerId: app.workerId,
          containerId: app.containerInfo.containerId,
          name: app.containerInfo.name,
          image: app.containerInfo.image,
          status: app.containerInfo.status,
          labels: JSON.stringify(redactSecretLabels(app.containerInfo.labels)),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        appsDiscovered++;
        console.log(`[app-discovery] Imported application: ${app.name} (${app.domain || 'no domain'})`);
      } catch (error: any) {
        console.error(`[app-discovery] Failed to import container ${container.Id}:`, error.message);
      }
    }

    console.log(
      `[app-discovery] Discovery complete: ${appsDiscovered} apps discovered, ` +
      `${teamsCreated} teams created, ${stacksCreated} stacks created`
    );
    return { appsDiscovered, teamsCreated, stacksCreated };
  } finally {
    podmanClient.destroy();
  }
}
