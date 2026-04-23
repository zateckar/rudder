import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, deployments, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const app = await db.select().from(applications).where(eq(applications.id, params.id)).get();
  if (!app) return json({ error: 'Application not found' }, { status: 404 });

  const rows = await db.select({
    id: deployments.id,
    version: deployments.version,
    status: deployments.status,
    image: deployments.image,
    deployedBy: deployments.deployedBy,
    errorMessage: deployments.errorMessage,
    createdAt: deployments.createdAt,
    finishedAt: deployments.finishedAt,
  })
    .from(deployments)
    .where(eq(deployments.applicationId, params.id))
    .orderBy(desc(deployments.version))
    .limit(50)
    .all();

  // Resolve deployer usernames
  const userIds = [...new Set(rows.filter(r => r.deployedBy).map(r => r.deployedBy!))];
  const userMap = new Map<string, string>();
  for (const uid of userIds) {
    const u = await db.select({ id: users.id, fullName: users.fullName, username: users.username })
      .from(users)
      .where(eq(users.id, uid))
      .get();
    if (u) userMap.set(u.id, u.fullName || u.username);
  }

  const result = rows.map(r => ({
    ...r,
    deployedByName: r.deployedBy ? (userMap.get(r.deployedBy) ?? 'Unknown') : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    finishedAt: r.finishedAt instanceof Date ? r.finishedAt.toISOString() : r.finishedAt,
  }));

  return json({ deployments: result });
}

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { deploymentId } = body;

  if (!deploymentId) {
    return json({ error: 'deploymentId is required' }, { status: 400 });
  }

  // Load the source deployment
  const source = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!source) return json({ error: 'Deployment not found' }, { status: 404 });
  if (source.applicationId !== params.id) {
    return json({ error: 'Deployment does not belong to this application' }, { status: 400 });
  }

  // Load the application
  const app = await db.select().from(applications).where(eq(applications.id, params.id)).get();
  if (!app) return json({ error: 'Application not found' }, { status: 404 });

  // Update the application record with the old deployment's config
  await db.update(applications)
    .set({
      manifest: source.manifest,
      environment: source.environment,
      volumes: source.volumes,
      updatedAt: new Date(),
    })
    .where(eq(applications.id, params.id));

  // Determine next version number
  const lastDeployment = await db.select({ version: deployments.version })
    .from(deployments)
    .where(eq(deployments.applicationId, params.id))
    .orderBy(desc(deployments.version))
    .limit(1)
    .get();
  const nextVersion = (lastDeployment?.version ?? 0) + 1;

  // Create a new deployment record for the rollback
  const rollbackDeploymentId = uuid();
  await db.insert(deployments).values({
    id: rollbackDeploymentId,
    applicationId: params.id,
    version: nextVersion,
    manifest: source.manifest,
    environment: source.environment,
    volumes: source.volumes,
    image: source.image,
    status: 'rolled_back',
    deployedBy: userId,
    createdAt: new Date(),
    finishedAt: new Date(),
  });

  // Trigger a redeploy by calling the deploy endpoint internally
  try {
    const deployRes = await fetch(new URL('/api/applications/deploy', request.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: request.headers.get('Cookie') || '',
      },
      body: JSON.stringify({ applicationId: params.id, action: 'deploy' }),
    });

    if (!deployRes.ok) {
      const errBody = await deployRes.json();
      return json({ error: errBody.error || 'Redeploy failed' }, { status: 500 });
    }

    return json({ success: true, message: `Rolled back to version ${source.version}` });
  } catch (error: any) {
    // Mark rollback deployment as failed
    await db.update(deployments)
      .set({ status: 'failed', errorMessage: error.message, finishedAt: new Date() })
      .where(eq(deployments.id, rollbackDeploymentId));

    return json({ error: error.message }, { status: 500 });
  }
}
