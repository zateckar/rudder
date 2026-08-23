import { redirect, fail } from '@sveltejs/kit';
import { db, safeWorkerColumns, safeUserColumns } from '$lib/db';
import { applications, users, workers, teams, teamMembers, volumes, stacks } from '$lib/db/schema';
import { eq, inArray, or, isNull } from 'drizzle-orm';
import {
  canAccessApplication,
  requirePageUser,
  stackAcceptsTeam,
  userTeams as allUserTeams,
} from '$lib/server/auth';
import { assertDomainAvailable } from '$lib/server/domains';
import { ALLOWED_DOMAINS_UNSUPPORTED } from '$lib/server/oidc';
import { DEFAULT_HEALTH_TIMEOUT_S } from '$lib/server/generations';
import { imageReferenceError } from '$lib/server/image-reference';
import { decryptField, encryptField } from '$lib/server/encryption';

/**
 * Volume-registry ids this application's `volumes` column already names.
 *
 * Tolerates the column being absent or malformed the same way `singleMountIntents`
 * does — a form that cannot be rendered is worse than one missing an option.
 */
function referencedVolumeIds(raw: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ids;
    for (const entry of parsed) {
      if (entry && typeof entry.volumeId === 'string') ids.add(entry.volumeId);
    }
  } catch {
    // Same as elsewhere: unparseable means nothing to carry over.
  }
  return ids;
}

export const load = async (event: { params: { id: string }; locals: App.Locals; cookies: any }) => {
  const currentUser = requirePageUser(event).user;
  const userId = currentUser.id;

  // Membership decides this, not existence. Loading the row on an id alone put
  // another team's manifest, plaintext environment and domain into the SSR
  // payload for anyone who could guess an application id.
  const access = await canAccessApplication(event.cookies, event.params.id);
  if (!access) throw redirect(303, '/applications');
  const app = access.application;

  const userTeams = await allUserTeams(event);

  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();

  // Load available volumes for the volume registry dropdown.
  //
  // This used to include every teamless volume for every member, which listed
  // the names and mount paths of volumes belonging to nobody to anyone who
  // opened any edit form. Teamless volumes are admin-only now (see
  // /api/volumes/[id]), so the only reason to show one to a member is that this
  // application already mounts it — dropping it from the options would silently
  // remove the mount the next time anyone saved the form.
  let availableVolumes;
  if (currentUser?.role === 'admin') {
    availableVolumes = await db.select().from(volumes).all();
  } else {
    const teamIds = userTeams.map((t: { id: string }) => t.id);
    const referencedIds = referencedVolumeIds(app.volumes);

    const candidates =
      teamIds.length > 0
        ? await db.select().from(volumes).where(inArray(volumes.teamId, teamIds)).all()
        : [];
    const known = new Set(candidates.map((v) => v.id));

    const stillReferenced = [...referencedIds].filter((id) => !known.has(id));
    const carriedOver = stillReferenced.length > 0
      ? await db.select().from(volumes).where(inArray(volumes.id, stillReferenced)).all()
      : [];

    availableVolumes = [...candidates, ...carriedOver];
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
    // `authConfig` is encrypted at rest and decrypted here, because this form
    // prefills itself from it — the OIDC client secret and session key have to
    // reach the browser for "edit without retyping them" to work at all. This
    // is the one page that legitimately needs them; the list and the dashboard
    // use `safeApplicationColumns`, which drops the column entirely.
    application: { ...app, authConfig: decryptField(app.authConfig) },
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
    // Same rule as the loader: the caller must already have access to this
    // application. Without it any authenticated user could rewrite any
    // application's manifest, environment, domain and worker — and reassign it
    // to a team of their own, which hands them every other permission on it.
    const access = await canAccessApplication(cookies, params.id);
    if (!access) return fail(404, { error: 'Application not found' });
    const { ctx, application: app } = access;

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

    // Hostnames are global — two applications sharing one would produce two
    // Traefik routers with the same Host rule and arbitrary routing between them.
    const domainConflict = await assertDomainAvailable(domain, app.id);
    if (domainConflict) {
      return fail(400, { error: domainConflict });
    }

    // Git-based source fields
    const gitRepo = formData.get('gitRepo')?.toString() || null;
    const gitBranch = formData.get('gitBranch')?.toString() || null;
    const gitDockerfile = formData.get('gitDockerfile')?.toString() || null;

    let manifest = formData.get('manifest')?.toString() || app.manifest || '';
    let environment: string | null = app.environment;
    let volumes: string | null = app.volumes;

    if (app.type === 'single') {
      // Re-parse / validate. Same shape as the create form: the catch branch
      // used to wrap whatever arrived without re-checking, so an empty or
      // malformed image was stored and only surfaced at deploy time.
      if (!gitRepo) {
        let image: string;
        try {
          const cfg = JSON.parse(manifest);
          image = typeof cfg?.image === 'string' ? cfg.image.trim() : '';
        } catch {
          image = manifest.trim();
          manifest = JSON.stringify({ image });
        }

        if (!image) return fail(400, { error: 'Container image is required' });
        const badImage = imageReferenceError(image);
        if (badImage) return fail(400, { error: badImage });
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

    // Deploy behaviour. Both fields are absent from forms that do not offer
    // them, which must leave the stored value alone rather than reset it.
    const healthTimeoutRaw = formData.get('healthTimeoutSeconds');
    const healthTimeoutSeconds =
      healthTimeoutRaw === null
        ? (app.healthTimeoutSeconds ?? null)
        : healthTimeoutRaw.toString().trim()
          ? Math.max(10, Math.min(3600, parseInt(healthTimeoutRaw.toString()) || DEFAULT_HEALTH_TIMEOUT_S))
          : null;

    const retainRaw = formData.get('retainPreviousMinutes');
    const retainPreviousMinutes =
      retainRaw === null
        ? (app.retainPreviousMinutes ?? 0)
        : Math.max(0, Math.min(1440, parseInt(retainRaw.toString()) || 0));

    // Security & Access Control
    const rateLimitAvgStr = formData.get('rateLimitAvg')?.toString();
    const rateLimitBurstStr = formData.get('rateLimitBurst')?.toString();
    const rateLimitAvg = rateLimitAvgStr ? parseInt(rateLimitAvgStr) || null : null;
    const rateLimitBurst = rateLimitBurstStr ? parseInt(rateLimitBurstStr) || null : null;
    const authType = (formData.get('authType')?.toString() || 'global') as 'none' | 'oidc' | 'global';
    const authConfig = authType === 'oidc' ? (formData.get('authConfig')?.toString() || null) : null;

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

    const stackId = formData.get('stackId')?.toString() || null;

    // Moving an application between teams is an admin action: it transfers
    // every permission on it, so a member being able to do it would be a way to
    // pull another team's workload into their own. The form still submits the
    // field for admins; for everyone else the current owner stands.
    let nextTeamId = app.teamId;
    if (teamId !== app.teamId) {
      if (ctx.user.role !== 'admin') {
        return fail(403, { error: 'Only admins can move an application to another team' });
      }
      const target = await db.select().from(teams).where(eq(teams.id, teamId)).get();
      if (!target) return fail(400, { error: 'Target team not found' });
      nextTeamId = teamId;
    }

    // The stack is submitted too, and it scopes bulk deploy/stop/restart in
    // /api/stacks/[id] — so an application parked in another team's stack is one
    // that team can act on. Only a stack owned by the same team is accepted.
    //
    // Checked only when the value is actually changing. A row that already points
    // at a stack from before this rule — or one whose application has no team at
    // all, which the schema permits — must stay editable, or the form that could
    // fix it is the form that refuses to save.
    if (stackId && stackId !== app.stackId && !(await stackAcceptsTeam(stackId, nextTeamId))) {
      return fail(400, { error: 'That stack does not belong to this application\'s team' });
    }

    await db
      .update(applications)
      .set({
        name,
        description,
        workerId,
        teamId: nextTeamId,
        domain,
        manifest,
        environment,
        volumes,
        restartPolicy,
        rateLimitAvg,
        rateLimitBurst,
        authType,
        // Encrypted at rest: it carries the per-app OIDC client secret and the
        // 32-character session key the Traefik plugin uses as an AES key, which
        // makes it the same class of material as `workers.oidcClientSecret`.
        // `encryptField` is idempotent, so a re-save of a row that was written
        // before this does not double-encrypt.
        authConfig: encryptField(authConfig),
        stackId,
        replicas,
        healthcheck,
        healthTimeoutSeconds,
        retainPreviousMinutes,
        gitRepo: gitRepo || null,
        gitBranch: gitBranch || null,
        gitDockerfile: gitDockerfile || null,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, params.id));

    throw redirect(303, `/applications/${params.id}`);
  },
};
