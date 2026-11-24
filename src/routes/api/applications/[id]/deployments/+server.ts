import { json } from '@sveltejs/kit';
import { db } from '#lib/db/index.ts';
import { deployments, users } from '#lib/db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { fastRollbackTargets } from '#lib/server/deploy.ts';
import { parseCapturedOutput } from '#lib/server/deploy/failure-logs.ts';
import { canAccessApplication } from '#lib/server/auth.ts';
import { rollbackToDeployment } from '#lib/server/rollback.ts';

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
    // The containers a failed deploy printed before it removed them. Same team
    // scope as the rest of this response, which is the check above.
    failureLogs: deployments.failureLogs,
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
    failureLogs: parseCapturedOutput(r.failureLogs),
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

  // Shared with the MCP server — see #lib/server/rollback.
  const result = await rollbackToDeployment(access.application, deploymentId, userId);
  if (!result.success) {
    return json(
      { error: result.message, deploymentId: result.deploymentId },
      { status: result.statusCode ?? 500 },
    );
  }
  return json({ success: true, ...(result.fast ? { fast: true } : {}), message: result.message });
}
