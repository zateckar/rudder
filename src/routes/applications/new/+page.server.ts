import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, users, workers, teams, teamMembers, volumes, stacks } from '$lib/db/schema';
import { eq, inArray, or, isNull, and } from 'drizzle-orm';
import { selectWorker, getAllWorkerResources, getAllEligibleWorkers } from '$lib/server/worker-selector';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  let userTeams;
  if (currentUser?.role === 'admin') {
    userTeams = await db.select().from(teams).all();
  } else {
    const memberships = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    const teamIds = memberships.map((m) => m.teamId);
    userTeams =
      teamIds.length > 0
        ? await db.select().from(teams).where(inArray(teams.id, teamIds)).all()
        : [];
  }

  const selection = await selectWorker();
  const allEligible = await getAllEligibleWorkers();

  // Load available volumes for the volume registry dropdown
  let availableVolumes;
  if (currentUser?.role === 'admin') {
    availableVolumes = await db.select().from(volumes).all();
  } else {
    const teamIds = userTeams.map((t: { id: string }) => t.id);
    availableVolumes =
      teamIds.length > 0
        ? await db.select().from(volumes)
            .where(or(inArray(volumes.teamId, teamIds), isNull(volumes.teamId)))
            .all()
        : await db.select().from(volumes).where(isNull(volumes.teamId)).all();
  }

  // Load available stacks for the user's teams
  const stackTeamIds = userTeams.map((t: { id: string }) => t.id);
  const availableStacks = stackTeamIds.length > 0
    ? await db.select().from(stacks).where(inArray(stacks.teamId, stackTeamIds)).all()
    : [];

  return {
    user: currentUser,
    teams: userTeams,
    volumes: availableVolumes,
    stacks: availableStacks,
    selectedWorker: selection?.worker ?? null,
    workerResources: selection?.resources ?? null,
    noWorkersAvailable: selection === null,
    allWorkers: allEligible,
  };
};

export const actions = {
  default: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();

    const name = formData.get('name')?.toString();
    const teamId = formData.get('teamId')?.toString();
    const description = formData.get('description')?.toString() || null;
    const stackId = formData.get('stackId')?.toString() || null;
    const type = (formData.get('type')?.toString() || 'single') as 'single' | 'compose' | 'k8s';
    const restartPolicy = (formData.get('restartPolicy')?.toString() || 'always') as
      | 'no'
      | 'on-failure'
      | 'always'
      | 'unless-stopped';

    if (!name || !teamId) {
      return fail(400, { error: 'Missing required fields (name, team)' });
    }

    // Validate name format (lowercase, alphanumeric, hyphens only)
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return fail(400, { error: 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens' });
    }

    // Check for unique name within the same team
    const existingApp = await db.select().from(applications)
      .where(and(eq(applications.name, name), eq(applications.teamId, teamId)))
      .get();
    if (existingApp) {
      return fail(400, { error: `An application named "${name}" already exists in this team` });
    }

    // Worker selection — use form data or auto-select
    const formWorkerId = formData.get('workerId')?.toString();
    let worker;
    if (formWorkerId) {
      worker = await db.select().from(workers).where(eq(workers.id, formWorkerId)).get();
      if (!worker) {
        return fail(400, { error: 'Selected worker not found' });
      }
    } else {
      const selection = await selectWorker();
      if (!selection) {
        return fail(400, { error: 'No workers with sufficient resources available. All workers are above 85% utilization or offline.' });
      }
      worker = selection.worker;
    }

    // Auto-generate domain: appname.workerBaseDomain
    const domain = `${name}.${worker.baseDomain}`;

    // Git-based source fields
    const gitRepo = formData.get('gitRepo')?.toString() || null;
    const gitBranch = formData.get('gitBranch')?.toString() || null;
    const gitDockerfile = formData.get('gitDockerfile')?.toString() || null;

    let manifest = formData.get('manifest')?.toString() || '';
    let environment: string | null = null;
    let volumes: string | null = null;

    if (type === 'single') {
      // For single containers, manifest is already a JSON string from the hidden input
      // Validate it has an image (unless git-based)
      if (!gitRepo) {
        try {
          const cfg = JSON.parse(manifest);
          if (!cfg.image) {
            return fail(400, { error: 'Container image is required' });
          }
        } catch {
          // If manifest is plain text (image name), wrap it
          manifest = JSON.stringify({ image: manifest });
        }
      } else {
        // For git-based apps, set a placeholder image in manifest
        try {
          const cfg = JSON.parse(manifest);
          cfg.image = `rudder/${name}:latest`;
          manifest = JSON.stringify(cfg);
        } catch {
          manifest = JSON.stringify({ image: `rudder/${name}:latest` });
        }
      }

      // Environment variables
      const envVarsRaw = formData.get('envVars')?.toString();
      if (envVarsRaw) {
        try {
          const parsed = JSON.parse(envVarsRaw);
          // Filter out empty rows
          const filtered = parsed.filter(
            (e: { key: string; value: string }) => e.key.trim() !== ''
          );
          environment = JSON.stringify(filtered);
        } catch {
          // ignore
        }
      }

      // Volume mounts
      const volumesRaw = formData.get('volumeMounts')?.toString();
      if (volumesRaw) {
        try {
          const parsed = JSON.parse(volumesRaw);
          const filtered = parsed.filter(
            (v: { hostPath: string; containerPath: string; volumeId?: string }) =>
              v.volumeId || (v.hostPath?.trim() !== '' && v.containerPath?.trim() !== '')
          );
          volumes = JSON.stringify(filtered);
        } catch {
          // ignore
        }
      }

      // Port mappings — store inside manifest JSON
      const portsRaw = formData.get('ports')?.toString();
      if (portsRaw) {
        try {
          const parsedPorts = JSON.parse(portsRaw);
          const filteredPorts = parsedPorts.filter(
            (p: { containerPort: string }) => p.containerPort.trim() !== ''
          );
          const cfg = JSON.parse(manifest);
          cfg.ports = filteredPorts;
          manifest = JSON.stringify(cfg);
        } catch {
          // ignore
        }
      }
    }

    // Replicas
    const replicasStr = formData.get('replicas')?.toString();
    const replicas = replicasStr ? Math.max(1, Math.min(10, parseInt(replicasStr) || 1)) : 1;

    // Health check
    const healthcheckRaw = formData.get('healthcheck')?.toString();
    let healthcheck: string | null = null;
    if (healthcheckRaw) {
      try {
        const hc = JSON.parse(healthcheckRaw);
        if (hc.test && hc.test.trim()) {
          healthcheck = healthcheckRaw;
        }
      } catch {
        // ignore invalid JSON
      }
    }

    // Security & Access Control
    const rateLimitAvgStr = formData.get('rateLimitAvg')?.toString();
    const rateLimitBurstStr = formData.get('rateLimitBurst')?.toString();
    const rateLimitAvg = rateLimitAvgStr ? parseInt(rateLimitAvgStr) || null : null;
    const rateLimitBurst = rateLimitBurstStr ? parseInt(rateLimitBurstStr) || null : null;
    const authType = (formData.get('authType')?.toString() || 'none') as 'none' | 'oidc';
    const authConfig = authType === 'oidc' ? (formData.get('authConfig')?.toString() || null) : null;

    // Validate OIDC config if auth type is oidc
    if (authType === 'oidc' && authConfig) {
      try {
        const cfg = JSON.parse(authConfig);
        if (!cfg.providerURL || !cfg.clientID || !cfg.clientSecret || !cfg.sessionEncryptionKey) {
          return fail(400, { error: 'OIDC authentication requires Provider URL, Client ID, Client Secret, and Session Encryption Key' });
        }
        if (cfg.sessionEncryptionKey.length < 32) {
          return fail(400, { error: 'Session Encryption Key must be at least 32 characters' });
        }
      } catch {
        return fail(400, { error: 'Invalid OIDC configuration' });
      }
    }

    const { v4: uuidv4 } = await import('uuid');
    const appId = uuidv4();

    await db.insert(applications).values({
      id: appId,
      name,
      description,
      workerId: worker.id,
      teamId,
      stackId,
      domain,
      type,
      deploymentFormat: type === 'k8s' ? 'k8s' : 'compose',
      manifest,
      environment,
      volumes,
      restartPolicy,
      rateLimitAvg,
      rateLimitBurst,
      authType,
      authConfig,
      replicas,
      healthcheck,
      gitRepo: gitRepo || null,
      gitBranch: gitBranch || null,
      gitDockerfile: gitDockerfile || null,
      createdBy: userId || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    throw redirect(303, `/applications/${appId}`);
  },
};
