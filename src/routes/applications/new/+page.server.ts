import { redirect, fail } from '@sveltejs/kit';
import { db, safeUserColumns, toSafeWorker } from '$lib/db';
import { applications, users, workers, teams, teamMembers, volumes } from '$lib/db/schema';
import { eq, inArray, or, isNull, and } from 'drizzle-orm';
import { selectWorker, getAllWorkerResources, getAllEligibleWorkers } from '$lib/server/worker-selector';
import { buildAppDomain, assertDomainAvailable } from '$lib/server/domains';
import { ALLOWED_DOMAINS_UNSUPPORTED, normalizeTokenHeader, tokenHeadersError } from '$lib/server/oidc';
import { imageReferenceError } from '$lib/server/image-reference';
import { checkApplicationQuota } from '$lib/server/quota';
import {
  canWriteToTeam,
  currentUser as sessionUser,
  requirePageUser,
  userTeams as allUserTeams,
} from '$lib/server/auth';
import { encryptField } from '$lib/server/encryption';
import {
  EXPOSED_PORTS_ERROR,
  MAX_ROUTES_PER_CONTAINER,
  parsePortList,
  serializeExposedPorts,
} from '$lib/server/deploy/plan';
import {
  APPSEC_RULES_ERROR,
  appsecRuleError,
  parseRuleList,
  serializeAppsecRules,
} from '$lib/server/appsec';

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageUser(event).user;
  const userTeams = await allUserTeams(event);

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

  // `toSafeWorker` rather than another hand-written destructure. The one that
  // used to live here listed the secret columns by name and had already fallen
  // behind: `configBasicPassword` was not in it, so it was published from the
  // moment that column existed. `selection.resources` and `allEligible` now
  // arrive stripped from the selector itself.
  return {
    user: currentUser,
    teams: userTeams,
    volumes: availableVolumes,
    selectedWorker: selection?.worker ? toSafeWorker(selection.worker) : null,
    workerResources: selection?.resources ?? null,
    noWorkersAvailable: selection === null,
    allWorkers: allEligible,
  };
};

export const actions = {
  default: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = sessionUser(event);
    if (!ctx) {
      return fail(401, { error: 'Unauthorized' });
    }
    const userId = ctx.user.id;
    const formData = await event.request.formData();

    const name = formData.get('name')?.toString();
    const teamId = formData.get('teamId')?.toString();
    const description = formData.get('description')?.toString() || null;
    const type = (formData.get('type')?.toString() || 'single') as 'single' | 'compose' | 'k8s';
    const restartPolicy = (formData.get('restartPolicy')?.toString() || 'always') as
      | 'no'
      | 'on-failure'
      | 'always'
      | 'unless-stopped';

    if (!name || !teamId) {
      return fail(400, { error: 'Missing required fields (name, team)' });
    }

    // Blank means undeclared — the single-route default every application has
    // had — not "publish nothing". See the same field in the edit action.
    const exposedPortsRaw = formData.get('exposedPorts')?.toString().trim() ?? '';
    const exposedPorts = exposedPortsRaw === '' ? null : parsePortList(exposedPortsRaw);
    if (exposedPortsRaw !== '' && exposedPorts === null) {
      return fail(400, { error: EXPOSED_PORTS_ERROR });
    }
    if (exposedPorts && exposedPorts.length > MAX_ROUTES_PER_CONTAINER) {
      return fail(400, {
        error: `Public ports: at most ${MAX_ROUTES_PER_CONTAINER} can be published — a worker has ${MAX_ROUTES_PER_CONTAINER} HTTPS entryPoints.`,
      });
    }

    // Rejected rather than dropped: someone who mistypes a rule id and is told
    // nothing believes the rule is off, and goes on being banned by it.
    const appsecRules = parseRuleList(formData.get('appsecDisabledRules')?.toString() ?? '');
    if (appsecRules === null) return fail(400, { error: APPSEC_RULES_ERROR });
    const appsecRefusal = appsecRuleError(appsecRules);
    if (appsecRefusal) return fail(400, { error: appsecRefusal });

    // The team is submitted, not derived, and the loader above only scopes the
    // *dropdown*. Without this, any authenticated user could name any team in the
    // installation and have an application created inside it — spending that
    // team's quota, claiming a domain and deploying on their workers.
    if (!(await canWriteToTeam(ctx, teamId))) {
      return fail(403, { error: 'You are not a member of that team' });
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

    // The same limit kubectl is held to. This path did not check it at all, so
    // a team at its application quota was refused by `kubectl apply` and
    // allowed by the New Application button.
    const quota = await checkApplicationQuota(teamId);
    if (!quota.allowed) {
      return fail(400, { error: quota.message ?? 'Team quota exceeded' });
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

    // Canonical hostname: <app>.<workerBaseDomain> — same for every deployment type.
    const domain = buildAppDomain(name, worker.baseDomain);
    const domainConflict = await assertDomainAvailable(domain);
    if (domainConflict) {
      return fail(400, { error: domainConflict });
    }

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
        let image: string;
        try {
          const cfg = JSON.parse(manifest);
          image = typeof cfg?.image === 'string' ? cfg.image.trim() : '';
        } catch {
          // Plain text is the image name itself.
          image = manifest.trim();
          manifest = JSON.stringify({ image });
        }

        // Checked here rather than only at deploy time. The catch branch used to
        // wrap whatever arrived without re-checking, so an empty image was
        // stored and only surfaced later as a Podman "invalid reference format"
        // — an HTTP 500 for what is plainly a form error.
        if (!image) {
          return fail(400, { error: 'Container image is required' });
        }
        const badImage = imageReferenceError(image);
        if (badImage) {
          return fail(400, { error: badImage });
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
    const authType = (formData.get('authType')?.toString() || 'global') as 'none' | 'oidc' | 'global';
    const authConfig = authType === 'oidc' ? (formData.get('authConfig')?.toString() || null) : null;

    // Header names for the worker-level middleware to deliver the OAuth tokens
    // under; empty means the token is not forwarded. Same validation as the
    // edit action — see `tokenHeadersError`.
    const oidcIdTokenHeader = normalizeTokenHeader(formData.get('oidcIdTokenHeader')?.toString());
    const oidcAccessTokenHeader = normalizeTokenHeader(formData.get('oidcAccessTokenHeader')?.toString());
    const badTokenHeader = tokenHeadersError(oidcIdTokenHeader, oidcAccessTokenHeader);
    if (badTokenHeader) return fail(400, { error: badTokenHeader });

    // Validate OIDC config if auth type is oidc
    if (authType === 'oidc' && authConfig) {
      try {
        const cfg = JSON.parse(authConfig);
        if (!cfg.providerURL || !cfg.clientID || !cfg.clientSecret || !cfg.sessionEncryptionKey) {
          return fail(400, { error: 'OIDC authentication requires Provider URL, Client ID, Client Secret, and Session Encryption Key' });
        }
        // The Traefik OIDC plugin uses this value directly as an AES-256 key.
        if (cfg.sessionEncryptionKey.length !== 32) {
          return fail(400, { error: 'Session Encryption Key must be exactly 32 characters' });
        }
        if (cfg.allowedUserDomains?.length) {
          return fail(400, { error: ALLOWED_DOMAINS_UNSUPPORTED });
        }
      } catch {
        return fail(400, { error: 'Invalid OIDC configuration' });
      }
    }

    const appId = crypto.randomUUID();

    await db.insert(applications).values({
      id: appId,
      name,
      description,
      workerId: worker.id,
      teamId,
      domain,
      type,
      deploymentFormat: type === 'k8s' ? 'k8s' : 'compose',
      manifest,
      environment,
      volumes,
      restartPolicy,
      exposedPorts: serializeExposedPorts(exposedPorts),
      appsecDisabledRules: serializeAppsecRules(appsecRules),
      rateLimitAvg,
      rateLimitBurst,
      authType,
      // Encrypted at rest — see the same field in the edit action.
      authConfig: encryptField(authConfig),
      oidcIdTokenHeader,
      oidcAccessTokenHeader,
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
