import { json } from '@sveltejs/kit';
import { db } from '#lib/db/index.ts';
import { workers, deployments } from '#lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { executeApplicationDeploy } from '#lib/server/deploy.ts';
import { isLifecycleAction, runLifecycleAction } from '#lib/server/app-lifecycle.ts';
import { deleteApplication } from '#lib/server/application-delete.ts';
import { canAccessApplication } from '#lib/server/auth.ts';
import { LockError } from '#lib/server/locks.ts';
import { applicationTask } from '#lib/server/application-operations.ts';
import { operationResponse } from '#lib/server/operation-http.ts';
import { rollbackToDeployment } from '#lib/server/rollback.ts';

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const body = await request.json();
  const { applicationId, action, fromDeploymentId } = body;

  if (!applicationId || !action) {
    return json({ error: 'Application ID and action required' }, { status: 400 });
  }

  // Deploying, stopping and removing an application are all team-scoped
  // operations — authenticating alone previously let any user act on any app.
  const access = await canAccessApplication(cookies, applicationId);
  if (!access) {
    return json({ error: 'Application not found' }, { status: 404 });
  }
  const { ctx, application: app } = access;

  try {
    if (action === 'delete') {
      const result = await deleteApplication(app);
      return result.ok
        ? json({ success: true, message: 'Application deleted' })
        : json({ error: result.message }, { status: result.status });
    }

    if (!app.workerId) return json({ error: 'No worker assigned to this application' }, { status: 400 });
    const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
    if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

    // ──────────────────────── DEPLOY ────────────────────────
    if (action === 'deploy') {
      const deployUserId = ctx.user.id;

      // A rollback names the deployment it is restoring, and the digests come
      // from that row — never from the request body. Taking a digest from the
      // caller would let anyone who can deploy an application run arbitrary
      // image bytes under its name.
      if (fromDeploymentId) {
        const source = await db.select().from(deployments)
          .where(eq(deployments.id, fromDeploymentId))
          .get();
        if (!source || source.applicationId !== applicationId) {
          return json({ error: 'Source deployment not found for this application' }, { status: 400 });
        }
      }

      return await operationResponse(request, applicationTask(app, fromDeploymentId ? 'rollback' : 'deploy', deployUserId),
        (reportProgress) => fromDeploymentId
          ? rollbackToDeployment(app, fromDeploymentId, deployUserId, reportProgress)
          : executeApplicationDeploy(applicationId, deployUserId, { reportProgress }),
        (result, operationId) => result.success
          ? json({ success: true, message: result.message, operationId })
          : json({ error: result.message, deploymentId: result.deploymentId, operationId }, { status: result.statusCode || 500 }));

    // ──────── START / STOP / RESTART ───────────────────────
    } else if (isLifecycleAction(action)) {
      // Shared with the MCP server — see #lib/server/app-lifecycle.
      const result = await runLifecycleAction(app, worker, action);
      if (!result.found) return json({ error: 'Application not found' }, { status: 404 });
      // 200 even when some containers refused: something did happen, and the
      // message says exactly what. `success` and `failures` are what the caller
      // reads to decide whether to say so in red.
      return json({ success: result.success, message: result.message, failures: result.failures });

    } else {
      return json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    if (error instanceof LockError) {
      return json({ error: 'Another operation is running on this worker. Try again when it finishes.' }, { status: 409 });
    }
    console.error('Deployment error:', error);
    // A deploy that threw still recorded a history row, and carries its id —
    // see `DeployFailure`. That row holds what the containers printed.
    return json({ error: error.message, deploymentId: error?.deploymentId }, { status: 500 });
  }
}
