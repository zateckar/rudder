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
import { db } from '#lib/db/index.ts';
import { applications, deployments } from '#lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { executeApplicationDeploy, executeFastRollback, fastRollbackTargets, type DeployFailure } from './deploy';
import type { ReportOperationProgress } from '#lib/application-operations.ts';

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
  reportProgress?: ReportOperationProgress,
): Promise<RollbackResult> {
  const source = await db.select().from(deployments).where(eq(deployments.id, sourceDeploymentId)).get();
  if (!source) return { success: false, statusCode: 404, message: 'Deployment not found' };
  if (source.applicationId !== application.id) {
    return { success: false, statusCode: 400, message: 'Deployment does not belong to this application' };
  }

  // A retained generation is the fast path. Both paths take the worker lock
  // before they can change the application or write deployment history.
  try {
    if ((await fastRollbackTargets(application.id)).includes(source.id)) {
      const fast = await executeFastRollback(application.id, source.id, reportProgress, { source, userId, teamId: application.teamId });
      if (fast.success) {
        return { ...fast, fast: true, message: `Rolled back to version ${source.version} from the retained generation` };
      }
      console.warn(`[rollback] Fast path unavailable for ${application.id}: ${fast.message}`);
    }

    const result = await executeApplicationDeploy(application.id, userId, {
      pinnedDigests: source.imageDigest,
      rollback: {
        configuration: { manifest: source.manifest, environment: source.environment, volumes: source.volumes },
        teamId: application.teamId,
      },
      reportProgress,
    });
    if (!result.success) return result;
    return { ...result, message: `Rolled back to version ${source.version}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, statusCode: 500, message, deploymentId: (error as DeployFailure | null)?.deploymentId };
  }
}
