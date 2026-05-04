/**
 * apps/v1 catch-all: deployments CRUD + scale sub-resource.
 *
 * Paths handled:
 *   GET    deployments                              (all namespaces)
 *   GET    namespaces/:ns/deployments
 *   GET    namespaces/:ns/deployments/:name
 *   POST   namespaces/:ns/deployments               (create + deploy)
 *   PUT    namespaces/:ns/deployments/:name          (update + redeploy)
 *   PATCH  namespaces/:ns/deployments/:name          (update + redeploy)
 *   DELETE namespaces/:ns/deployments/:name
 *   GET    namespaces/:ns/deployments/:name/scale
 *   PUT    namespaces/:ns/deployments/:name/scale
 *   PATCH  namespaces/:ns/deployments/:name/scale
 */

import {
  authenticateK8s,
  k8sError,
  k8sJson,
  resolveTeamBySlug,
  getAccessibleTeams,
} from '$lib/server/k8s/auth';
import type { K8sAuthContext } from '$lib/server/k8s/auth';
import {
  applicationToDeployment,
  deploymentToScale,
  parseDeploymentBody,
  k8sList,
  matchPath,
} from '$lib/server/k8s/mapper';
import { db } from '$lib/db';
import {
  applications,
  containers,
  workers,
  deployments,
  deployWebhooks,
  applicationTemplates,
} from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { executeApplicationDeploy } from '$lib/server/deploy';
import { getRestPodmanClient } from '$lib/server/podman-client';

// ── GET ────────────────────────────────────────────────────────

export async function GET({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  // deployments (all namespaces)
  if ((m = matchPath(path, 'deployments')) !== null) {
    const accessibleTeams = await getAccessibleTeams(ctx);
    const items: any[] = [];
    for (const team of accessibleTeams) {
      const teamApps = await db
        .select()
        .from(applications)
        .where(eq(applications.teamId, team.id))
        .all();
      for (const app of teamApps) {
        const appContainers = await db
          .select()
          .from(containers)
          .where(eq(containers.applicationId, app.id))
          .all();
        items.push(applicationToDeployment(app, team.slug, appContainers));
      }
    }
    return k8sJson(k8sList('DeploymentList', 'apps/v1', items));
  }

  // namespaces/:ns/deployments
  if ((m = matchPath(path, 'namespaces/:ns/deployments')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const teamApps = await db
      .select()
      .from(applications)
      .where(eq(applications.teamId, team.id))
      .all();
    const items: any[] = [];
    for (const app of teamApps) {
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, app.id))
        .all();
      items.push(applicationToDeployment(app, team.slug, appContainers));
    }
    return k8sJson(k8sList('DeploymentList', 'apps/v1', items));
  }

  // namespaces/:ns/deployments/:name
  if ((m = matchPath(path, 'namespaces/:ns/deployments/:name')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const app = await findAppByName(team.id, m.name);
    if (!app)
      return k8sError(404, `deployments.apps "${m.name}" not found`);

    const appContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();
    return k8sJson(applicationToDeployment(app, team.slug, appContainers));
  }

  // namespaces/:ns/deployments/:name/scale
  if (
    (m = matchPath(path, 'namespaces/:ns/deployments/:name/scale')) !== null
  ) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const app = await findAppByName(team.id, m.name);
    if (!app)
      return k8sError(404, `deployments.apps "${m.name}" not found`);

    const appContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();
    return k8sJson(
      deploymentToScale(app, team.slug, appContainers.length),
    );
  }

  return k8sError(
    404,
    `the server doesn't have a resource type at path /apis/apps/v1/${path}`,
  );
}

// ── POST ───────────────────────────────────────────────────────

export async function POST({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  // namespaces/:ns/deployments
  if ((m = matchPath(path, 'namespaces/:ns/deployments')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    let body: any;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return k8sError(400, 'Invalid JSON body');
    }

    let parsed;
    try {
      parsed = parseDeploymentBody(body);
    } catch (e: any) {
      return k8sError(422, e.message, 'Invalid');
    }

    // Check name uniqueness
    const existing = await db
      .select()
      .from(applications)
      .where(eq(applications.name, parsed.name))
      .get();
    if (existing) {
      return k8sError(
        409,
        `deployments.apps "${parsed.name}" already exists`,
        'AlreadyExists',
      );
    }

    // Resolve worker
    const worker = await resolveWorker(parsed.workerAnnotation);
    if (!worker) {
      return k8sError(
        400,
        'No available worker. Set annotation rudder.dev/worker to specify one.',
      );
    }

    const domain =
      parsed.domain ||
      (worker.baseDomain
        ? `${parsed.name}.${team.slug}.${worker.baseDomain}`
        : null);
    const appId = crypto.randomUUID();

    await db.insert(applications).values({
      id: appId,
      name: parsed.name,
      description: parsed.description || null,
      workerId: worker.id,
      teamId: team.id,
      domain,
      type: 'single',
      deploymentFormat: 'compose',
      manifest: parsed.manifest,
      environment: parsed.environment,
      volumes: null,
      restartPolicy: parsed.restartPolicy as 'always' | 'no' | 'on-failure' | 'unless-stopped' | undefined,
      replicas: parsed.replicas,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Deploy
    try {
      await executeApplicationDeploy(appId, null);
    } catch (e: any) {
      console.error('Deploy failed after K8s create:', e.message);
    }

    const app = await db
      .select()
      .from(applications)
      .where(eq(applications.id, appId))
      .get();
    const appContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, appId))
      .all();
    return k8sJson(
      applicationToDeployment(app!, team.slug, appContainers),
      201,
    );
  }

  return k8sError(
    405,
    `Method POST not allowed for /apis/apps/v1/${path}`,
    'MethodNotAllowed',
  );
}

// ── PUT ────────────────────────────────────────────────────────

export async function PUT({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  if ((m = matchPath(path, 'namespaces/:ns/deployments/:name')) !== null) {
    return await handleUpdateDeployment(ctx, request, m.ns, m.name);
  }
  if (
    (m = matchPath(path, 'namespaces/:ns/deployments/:name/scale')) !== null
  ) {
    return await handleUpdateScale(ctx, request, m.ns, m.name);
  }

  return k8sError(
    405,
    `Method PUT not allowed for /apis/apps/v1/${path}`,
    'MethodNotAllowed',
  );
}

// ── PATCH ──────────────────────────────────────────────────────

export async function PATCH({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  if ((m = matchPath(path, 'namespaces/:ns/deployments/:name')) !== null) {
    return await handleUpdateDeployment(ctx, request, m.ns, m.name);
  }
  if (
    (m = matchPath(path, 'namespaces/:ns/deployments/:name/scale')) !== null
  ) {
    return await handleUpdateScale(ctx, request, m.ns, m.name);
  }

  return k8sError(
    405,
    `Method PATCH not allowed for /apis/apps/v1/${path}`,
    'MethodNotAllowed',
  );
}

// ── DELETE ─────────────────────────────────────────────────────

export async function DELETE({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  // namespaces/:ns/deployments/:name
  if ((m = matchPath(path, 'namespaces/:ns/deployments/:name')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const app = await findAppByName(team.id, m.name);
    if (!app)
      return k8sError(404, `deployments.apps "${m.name}" not found`);

    // Remove containers via Podman
    if (app.workerId) {
      const worker = await db
        .select()
        .from(workers)
        .where(eq(workers.id, app.workerId))
        .get();
      if (worker) {
        const podmanClient = getRestPodmanClient(worker);
        const appContainers = await db
          .select()
          .from(containers)
          .where(eq(containers.applicationId, app.id))
          .all();
        for (const c of appContainers) {
          try {
            await podmanClient.removeContainer(c.containerId, true);
          } catch {
            /* best-effort */
          }
          await db.delete(containers).where(eq(containers.id, c.id));
        }
        podmanClient.destroy();
      }
    }

    // Clean up FK references
    await db
      .delete(deployments)
      .where(eq(deployments.applicationId, app.id));
    await db
      .delete(deployWebhooks)
      .where(eq(deployWebhooks.applicationId, app.id));
    await db
      .update(applicationTemplates)
      .set({ sourceAppId: null })
      .where(eq(applicationTemplates.sourceAppId, app.id));

    // Delete the application
    await db.delete(applications).where(eq(applications.id, app.id));

    return k8sJson({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Success',
      details: { name: app.name, group: 'apps', kind: 'deployments' },
      code: 200,
    });
  }

  return k8sError(
    405,
    `Method DELETE not allowed for /apis/apps/v1/${path}`,
    'MethodNotAllowed',
  );
}

// ── Shared helpers ─────────────────────────────────────────────

async function findAppByName(teamId: string, name: string) {
  return db
    .select()
    .from(applications)
    .where(and(eq(applications.teamId, teamId), eq(applications.name, name)))
    .get();
}

async function handleUpdateDeployment(
  ctx: K8sAuthContext,
  request: Request,
  ns: string,
  name: string,
) {
  const team = await resolveTeamBySlug(ctx, ns);
  if (!team) return k8sError(404, `namespaces "${ns}" not found`);

  const app = await findAppByName(team.id, name);
  if (!app)
    return k8sError(404, `deployments.apps "${name}" not found`);

  let body: any;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return k8sError(400, 'Invalid JSON body');
  }

  let parsed;
  try {
    parsed = parseDeploymentBody(body);
  } catch (e: any) {
    return k8sError(422, e.message, 'Invalid');
  }

  // Update the application record
  const updates: Record<string, any> = {
    manifest: parsed.manifest,
    replicas: parsed.replicas,
    restartPolicy: parsed.restartPolicy,
    updatedAt: new Date(),
  };
  if (parsed.environment !== undefined) updates.environment = parsed.environment;
  if (parsed.domain) updates.domain = parsed.domain;
  if (parsed.description) updates.description = parsed.description;

  await db
    .update(applications)
    .set(updates)
    .where(eq(applications.id, app.id));

  // Redeploy
  try {
    await executeApplicationDeploy(app.id, null);
  } catch (e: any) {
    console.error('Deploy failed after K8s update:', e.message);
  }

  const updated = await db
    .select()
    .from(applications)
    .where(eq(applications.id, app.id))
    .get();
  const appContainers = await db
    .select()
    .from(containers)
    .where(eq(containers.applicationId, app.id))
    .all();
  return k8sJson(
    applicationToDeployment(updated!, team.slug, appContainers),
  );
}

async function handleUpdateScale(
  ctx: K8sAuthContext,
  request: Request,
  ns: string,
  name: string,
) {
  const team = await resolveTeamBySlug(ctx, ns);
  if (!team) return k8sError(404, `namespaces "${ns}" not found`);

  const app = await findAppByName(team.id, name);
  if (!app)
    return k8sError(404, `deployments.apps "${name}" not found`);

  let body: any;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return k8sError(400, 'Invalid JSON body');
  }

  const replicas = body.spec?.replicas;
  if (
    typeof replicas !== 'number' ||
    replicas < 1 ||
    replicas > 10 ||
    !Number.isInteger(replicas)
  ) {
    return k8sError(
      422,
      'spec.replicas must be an integer between 1 and 10',
      'Invalid',
    );
  }

  if (app.type !== 'single') {
    return k8sError(
      400,
      'Scaling is only supported for single-container deployments',
    );
  }

  await db
    .update(applications)
    .set({ replicas, updatedAt: new Date() })
    .where(eq(applications.id, app.id));

  // Redeploy with new replica count
  try {
    await executeApplicationDeploy(app.id, null);
  } catch (e: any) {
    console.error('Scale deploy failed:', e.message);
  }

  const updated = await db
    .select()
    .from(applications)
    .where(eq(applications.id, app.id))
    .get();
  const appContainers = await db
    .select()
    .from(containers)
    .where(eq(containers.applicationId, app.id))
    .all();
  return k8sJson(
    deploymentToScale(updated!, team.slug, appContainers.length),
  );
}

async function resolveWorker(workerAnnotation?: string) {
  if (workerAnnotation) {
    // Try by ID first, then by name
    let worker = await db
      .select()
      .from(workers)
      .where(eq(workers.id, workerAnnotation))
      .get();
    if (!worker) {
      worker = await db
        .select()
        .from(workers)
        .where(eq(workers.name, workerAnnotation))
        .get();
    }
    return worker || null;
  }
  // Auto-select: prefer online workers
  const allWorkers = await db.select().from(workers).all();
  return allWorkers.find((w) => w.status === 'online') || allWorkers[0] || null;
}
