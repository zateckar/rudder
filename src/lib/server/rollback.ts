/**
 * Rolling an application back to a recorded deployment.
 *
 * Lived in `POST /api/applications/[id]/deployments`, which finished the job by
 * calling `/api/applications/deploy` over HTTP with the caller's session cookie
 * forwarded. That only works for a caller who *has* a session cookie; the MCP
 * server authenticates with a bearer token, so the redeploy is now a direct
 * call to `executeApplicationDeploy` — which is all the HTTP hop ever did once
 * it had re-checked the authorization this function's callers already hold.
 *
 * Authorization is the caller's job: `application` must already be one the
 * caller may act on.
 */
import { db } from '$lib/db';
import { applications, deployments } from '$lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { executeApplicationDeploy, executeFastRollback, fastRollbackTargets } from './deploy';
import { withApplicationDomainWrite } from './domains';

export interface RollbackResult {
  success: boolean;
  /** HTTP-ish status for a failure; absent on success. */
  statusCode?: number;
  message: string;
  /** Whether the retained generation was restarted instead of redeploying. */
  fast?: boolean;
  /** The history row the redeploy wrote, when it got that far. */
  deploymentId?: string;
}

export async function rollbackToDeployment(
  application: typeof applications.$inferSelect,
  sourceDeploymentId: string,
  userId: string | null,
): Promise<RollbackResult> {
  const source = await db.select().from(deployments).where(eq(deployments.id, sourceDeploymentId)).get();
  if (!source) return { success: false, statusCode: 404, message: 'Deployment not found' };
  if (source.applicationId !== application.id) {
    return { success: false, statusCode: 400, message: 'Deployment does not belong to this application' };
  }

  // Update the application record with the old deployment's config
  const reservationConflict = await withApplicationDomainWrite({
    ...application, manifest: source.manifest, environment: source.environment,
  }, async () => {
    await db.update(applications)
      .set({
        manifest: source.manifest,
        environment: source.environment,
        volumes: source.volumes,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, application.id));
  });
  if (reservationConflict) return { success: false, statusCode: 409, message: reservationConflict };

  const lastDeployment = await db.select({ version: deployments.version })
    .from(deployments)
    .where(eq(deployments.applicationId, application.id))
    .orderBy(desc(deployments.version))
    .limit(1)
    .get();
  const nextVersion = (lastDeployment?.version ?? 0) + 1;

  // A history row for the rollback itself.
  const rollbackDeploymentId = crypto.randomUUID();
  await db.insert(deployments).values({
    id: rollbackDeploymentId,
    applicationId: application.id,
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
  if ((await fastRollbackTargets(application.id)).includes(source.id)) {
    const fast = await executeFastRollback(application.id, source.id);
    if (fast.success) {
      return {
        success: true,
        fast: true,
        message: `Rolled back to version ${source.version} from the retained generation`,
      };
    }
    console.warn(`[rollback] Fast path unavailable for ${application.id}: ${fast.message}`);
  }

  try {
    // The digests come from the source row — never from the caller — so a
    // rollback cannot be used to run arbitrary image bytes under this name.
    const result = await executeApplicationDeploy(application.id, userId, {
      pinnedDigests: source.imageDigest ?? null,
    });
    if (!result.success) {
      return {
        success: false,
        statusCode: result.statusCode || 500,
        message: result.message || 'Redeploy failed',
        deploymentId: result.deploymentId,
      };
    }
    return { success: true, message: `Rolled back to version ${source.version}`, deploymentId: result.deploymentId };
  } catch (error: any) {
    await db.update(deployments)
      .set({ status: 'failed', errorMessage: error?.message ?? String(error), finishedAt: new Date() })
      .where(eq(deployments.id, rollbackDeploymentId));
    return { success: false, statusCode: 500, message: error?.message ?? String(error), deploymentId: error?.deploymentId };
  }
}
