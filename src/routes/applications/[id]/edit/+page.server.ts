import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, users, workers, teams, teamMembers, volumes, stacks } from '$lib/db/schema';
import { eq, inArray, or, isNull } from 'drizzle-orm';

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  const app = await db.select().from(applications).where(eq(applications.id, params.id)).get();

  if (!app) throw redirect(303, '/applications');

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

  const allWorkers = await db.select().from(workers).all();

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

  // Parse the manifest for single containers
  let parsedManifest: {
    image?: string; command?: string; workingDir?: string;
    memoryLimit?: string; cpuLimit?: string;
    ports?: Array<{ containerPort: string; hostPort: string; protocol: string }>;
  } = {};

  if (app.type === 'single' && app.manifest) {
    try {
      parsedManifest = JSON.parse(app.manifest);
    } catch {
      // Legacy plain-text image name
      parsedManifest = { image: app.manifest };
    }
  }

  // Load available stacks for the user's teams
  const teamIds = userTeams.map((t: { id: string }) => t.id);
  const availableStacks = teamIds.length > 0
    ? await db.select().from(stacks).where(inArray(stacks.teamId, teamIds)).all()
    : [];

  return {
    user: currentUser,
    application: app,
    parsedManifest,
    workers: allWorkers,
    teams: userTeams,
    volumes: availableVolumes,
    stacks: availableStacks,
  };
};

export const actions = {
  default: async ({
    params,
    request,
    cookies,
  }: {
    params: { id: string };
    request: Request;
    cookies: any;
  }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const app = await db.select().from(applications).where(eq(applications.id, params.id)).get();
    if (!app) return fail(404, { error: 'Application not found' });

    const formData = await request.formData();

    const name = formData.get('name')?.toString();
    const workerId = formData.get('workerId')?.toString();
    const teamId = formData.get('teamId')?.toString();
    const domain = formData.get('domain')?.toString() || null;
    const description = formData.get('description')?.toString() || null;
    const restartPolicy = (formData.get('restartPolicy')?.toString() || 'always') as
      | 'no'
      | 'on-failure'
      | 'always'
      | 'unless-stopped';

    if (!name || !workerId || !teamId) {
      return fail(400, { error: 'Missing required fields' });
    }

    // Git-based source fields
    const gitRepo = formData.get('gitRepo')?.toString() || null;
    const gitBranch = formData.get('gitBranch')?.toString() || null;
    const gitDockerfile = formData.get('gitDockerfile')?.toString() || null;

    let manifest = formData.get('manifest')?.toString() || app.manifest || '';
    let environment: string | null = app.environment;
    let volumes: string | null = app.volumes;

    if (app.type === 'single') {
      // Re-parse / validate
      if (!gitRepo) {
        try {
          const cfg = JSON.parse(manifest);
          if (!cfg.image) return fail(400, { error: 'Container image is required' });
        } catch {
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
      if (envVarsRaw !== undefined) {
        try {
          const parsed = JSON.parse(envVarsRaw);
          const filtered = parsed.filter((e: { key: string }) => e.key.trim() !== '');
          environment = JSON.stringify(filtered);
        } catch {
          // keep existing
        }
      }

      // Volume mounts
      const volumesRaw = formData.get('volumeMounts')?.toString();
      if (volumesRaw !== undefined) {
        try {
          const parsed = JSON.parse(volumesRaw);
          const filtered = parsed.filter(
            (v: { hostPath: string; containerPath: string; volumeId?: string }) =>
              v.volumeId || (v.hostPath?.trim() !== '' && v.containerPath?.trim() !== '')
          );
          volumes = JSON.stringify(filtered);
        } catch {
          // keep existing
        }
      }

      // Port mappings — store inside manifest JSON
      const portsRaw = formData.get('ports')?.toString();
      if (portsRaw !== undefined) {
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
    const replicas = replicasStr ? Math.max(1, Math.min(10, parseInt(replicasStr) || 1)) : (app.replicas ?? 1);

    // Health check
    const healthcheckRaw = formData.get('healthcheck')?.toString();
    let healthcheck: string | null = app.healthcheck ?? null;
    if (healthcheckRaw !== undefined) {
      if (healthcheckRaw) {
        try {
          const hc = JSON.parse(healthcheckRaw);
          healthcheck = hc.test && hc.test.trim() ? healthcheckRaw : null;
        } catch {
          healthcheck = null;
        }
      } else {
        healthcheck = null;
      }
    }

    // Security & Access Control
    const rateLimitAvgStr = formData.get('rateLimitAvg')?.toString();
    const rateLimitBurstStr = formData.get('rateLimitBurst')?.toString();
    const rateLimitAvg = rateLimitAvgStr ? parseInt(rateLimitAvgStr) || null : null;
    const rateLimitBurst = rateLimitBurstStr ? parseInt(rateLimitBurstStr) || null : null;
    const authType = (formData.get('authType')?.toString() || 'none') as 'none' | 'oidc';
    const authConfig = authType === 'oidc' ? (formData.get('authConfig')?.toString() || null) : null;

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

    const stackId = formData.get('stackId')?.toString() || null;

    await db
      .update(applications)
      .set({
        name,
        description,
        workerId,
        teamId,
        domain,
        manifest,
        environment,
        volumes,
        restartPolicy,
        rateLimitAvg,
        rateLimitBurst,
        authType,
        authConfig,
        stackId,
        replicas,
        healthcheck,
        gitRepo: gitRepo || null,
        gitBranch: gitBranch || null,
        gitDockerfile: gitDockerfile || null,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, params.id));

    throw redirect(303, `/applications/${params.id}`);
  },
};
