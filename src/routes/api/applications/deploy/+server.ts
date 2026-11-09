import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers, containers, deployments, deployWebhooks, applicationTemplates } from '$lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { executeApplicationDeploy, resolveWorkerSSHConfig } from '$lib/server/deploy';
import { isLifecycleAction, runLifecycleAction } from '$lib/server/app-lifecycle';
import { teardownAppNetwork } from '$lib/server/networks';
import { canAccessApplication } from '$lib/server/auth';
import { LockError, withLock, workerDeployLock } from '$lib/server/locks';

type PodmanClient = ReturnType<typeof getRestPodmanClient>;

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

  if (!app.workerId) return json({ error: 'No worker assigned to this application' }, { status: 400 });

  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  // One client for whichever branch runs, destroyed in the `finally`. Each one
  // carries a keep-alive HTTPS agent, so a client that is dropped rather than
  // destroyed leaks its sockets to the worker for the life of the process.
  // `deploy` builds its own inside executeApplicationDeploy and needs none here.
  let podmanClient: ReturnType<typeof getRestPodmanClient> | null = null;

  try {
    // ──────────────────────── DEPLOY ────────────────────────
    if (action === 'deploy') {
      const deployUserId = ctx.user.id;

      // A rollback names the deployment it is restoring, and the digests come
      // from that row — never from the request body. Taking a digest from the
      // caller would let anyone who can deploy an application run arbitrary
      // image bytes under its name.
      let pinnedDigests: string | null = null;
      if (fromDeploymentId) {
        const source = await db.select().from(deployments)
          .where(eq(deployments.id, fromDeploymentId))
          .get();
        if (!source || source.applicationId !== applicationId) {
          return json({ error: 'Source deployment not found for this application' }, { status: 400 });
        }
        pinnedDigests = source.imageDigest ?? null;
      }

      const result = await executeApplicationDeploy(applicationId, deployUserId, { pinnedDigests });
      if (!result.success) {
        // `deploymentId` names the history row this attempt wrote, when it got
        // that far. It is where the failed containers' output was captured
        // before they were removed, so the page can open the right one.
        return json(
          { error: result.message, deploymentId: result.deploymentId },
          { status: result.statusCode || 500 },
        );
      }
      return json({ success: true, message: result.message });

    // ──────── START / STOP / RESTART ───────────────────────
    } else if (isLifecycleAction(action)) {
      // Shared with the MCP server — see $lib/server/app-lifecycle.
      const result = await runLifecycleAction(app, worker, action);
      if (!result.found) return json({ error: 'Application not found' }, { status: 404 });
      // 200 even when some containers refused: something did happen, and the
      // message says exactly what. `success` and `failures` are what the caller
      // reads to decide whether to say so in red.
      return json({ success: result.success, message: result.message, failures: result.failures });

    // ──────────────────────── DELETE ───────────────────────
    } else if (action === 'delete') {
      return await withLock(workerDeployLock(worker.id), {
        operation: `delete ${app.name}`, holder: crypto.randomUUID(),
      }, async () => {
      if (!db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()) {
        return json({ error: 'Application not found' }, { status: 404 });
      }
      db.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
        .where(eq(workers.id, worker.id)).run();
      podmanClient = getRestPodmanClient(worker);
      // Every generation, unlike the lifecycle actions above: deleting the
      // application must not leave a retained generation behind on the worker.
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, applicationId))
        .all();

      // Delete deploy webhooks
      await db.delete(deployWebhooks).where(eq(deployWebhooks.applicationId, applicationId));

      // Delete deployment history
      await db.delete(deployments).where(eq(deployments.applicationId, applicationId));

      // Unlink any templates referencing this app
      await db.update(applicationTemplates)
        .set({ sourceAppId: null })
        .where(eq(applicationTemplates.sourceAppId, applicationId));

      // Teardown per-app network.
      // Pass SSH config so teardownAppNetwork can purge stale Netavark iptables
      // rules immediately after network removal (prevents 502 on next deploy).
      const containerIds = appContainers.map(c => c.containerId);
      const workerSSHConfig = await resolveWorkerSSHConfig(worker);
      try {
        await teardownAppNetwork(podmanClient, applicationId, containerIds, workerSSHConfig);
      } catch (e: any) {
        console.warn('Failed to teardown app network:', e.message);
      }

      for (const container of appContainers) {
        // Try to remove from Podman (best-effort — don't let Podman failures block DB cleanup)
        try {
          await podmanClient.removeContainer(container.containerId, true);
        } catch (e: any) {
          console.error('Failed to remove container from Podman (continuing with DB delete):', e.message);
        }
        // Always remove from DB so FK constraint is satisfied before deleting the application
        try {
          await db.delete(containers).where(eq(containers.id, container.id));
        } catch (e: any) {
          console.error('Failed to delete container from DB:', e.message);
        }
      }

      db.transaction((tx) => {
        tx.delete(applications).where(eq(applications.id, applicationId)).run();
        tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
          .where(eq(workers.id, worker.id)).run();
      });
      return json({ success: true, message: 'Application deleted' });
      });

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
  } finally {
    (podmanClient as PodmanClient | null)?.destroy();
  }
}
