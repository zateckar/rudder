import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, deployments, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { executeFastRollback, fastRollbackTargets } from '$lib/server/deploy';
import { canAccessApplication } from '$lib/server/auth';

/** Read the notes column, tolerating rows written before it existed. */
function parseNotes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  // Deploy history names images, digests and failure messages, so it is scoped
  // to the owning team like the application itself.
  const access = await canAccessApplication(cookies, params.id);
  if (!access) return json({ error: 'Application not found' }, { status: 404 });

  const rows = await db.select({
    id: deployments.id,
    version: deployments.version,
    status: deployments.status,
    image: deployments.image,
    imageDigest: deployments.imageDigest,
    deployedBy: deployments.deployedBy,
    errorMessage: deployments.errorMessage,
    notes: deployments.notes,
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

  // Which of these can be restored by restarting containers that are still on
  // the worker. Surfaced per row so the page can say which rollbacks are
  // seconds and which are a full redeploy, rather than letting the user find
  // out during an incident.
  const fast = new Set(await fastRollbackTargets(params.id));

  const result = rows.map(r => ({
    ...r,
    // Stored as a JSON array; sent as one so the page does not have to parse it.
    notes: parseNotes(r.notes),
    fastRollback: fast.has(r.id),
    deployedByName: r.deployedBy ? (userMap.get(r.deployedBy) ?? 'Unknown') : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    finishedAt: r.finishedAt instanceof Date ? r.finishedAt.toISOString() : r.finishedAt,
  }));

  return json({ deployments: result });
}

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  // A rollback rewrites the application's manifest, environment and volumes and
  // can restart its containers, so it is authorized before any of that happens.
  // Checking only for a session let any authenticated user roll back any team's
  // application: the internal deploy call below would refuse, but by then the
  // row had already been overwritten and the fast path may already have run.
  const access = await canAccessApplication(cookies, params.id);
  if (!access) return json({ error: 'Application not found' }, { status: 404 });
  const userId = access.ctx.user.id;

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
  const rollbackDeploymentId = crypto.randomUUID();
  await db.insert(deployments).values({
    id: rollbackDeploymentId,
    applicationId: params.id,
    version: nextVersion,
    manifest: source.manifest,
    environment: source.environment,
    volumes: source.volumes,
    image: source.image,
    // Carried forward so this row records the same bytes the redeploy below is
    // pinned to; without it the rollback's own history entry would claim only
    // a tag, and rolling back to *it* later would resolve the tag afresh.
    imageDigest: source.imageDigest,
    status: 'rolled_back',
    deployedBy: userId,
    createdAt: new Date(),
    finishedAt: new Date(),
  });

  // If that version's containers are still on the worker, stopped, starting
  // them and repointing the service is the whole rollback — no pull, no
  // recreate. A failure here is not fatal: it falls through to the redeploy
  // below, which is what would have happened anyway.
  if ((await fastRollbackTargets(params.id)).includes(source.id)) {
    const fast = await executeFastRollback(params.id, source.id);
    if (fast.success) {
      return json({
        success: true,
        fast: true,
        message: `Rolled back to version ${source.version} from the retained generation`,
      });
    }
    console.warn(`[rollback] Fast path unavailable for ${params.id}: ${fast.message}`);
  }

  // Trigger a redeploy by calling the deploy endpoint internally
  try {
    const deployRes = await fetch(new URL('/api/applications/deploy', request.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: request.headers.get('Cookie') || '',
      },
      // fromDeploymentId, not the digest itself: the deploy endpoint reads the
      // digest out of the row it names, so a caller cannot pin arbitrary bytes.
      body: JSON.stringify({
        applicationId: params.id,
        action: 'deploy',
        fromDeploymentId: source.id,
      }),
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
