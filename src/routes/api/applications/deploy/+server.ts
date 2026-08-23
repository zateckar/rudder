import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers, containers, deployments, deployWebhooks, applicationTemplates } from '$lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { executeApplicationDeploy, resolveWorkerSSHConfig } from '$lib/server/deploy';
import {
  applyToContainers,
  lifecycleMessage,
  type LifecycleVerb,
} from '$lib/server/deploy/lifecycle';
import { teardownAppNetwork } from '$lib/server/networks';
import { canAccessApplication } from '$lib/server/auth';
import { checkDeployQuota } from '$lib/server/quota';

type PodmanClient = ReturnType<typeof getRestPodmanClient>;

type LifecycleAction = 'start' | 'stop' | 'restart';

/**
 * The three actions that act on containers already on the worker.
 *
 * One table rather than three near-identical branches: they differed only in
 * the Podman call and the status to write, and keeping them apart is how the
 * same six-line comment came to be pasted three times.
 */
const LIFECYCLE: Record<
  LifecycleAction,
  {
    verb: LifecycleVerb;
    /** What the container's status becomes once the call lands. */
    status: string;
    run: (client: PodmanClient, containerId: string) => Promise<void>;
  }
> = {
  start: { verb: 'started', status: 'running', run: (c, id) => c.startContainer(id) },
  stop: { verb: 'stopped', status: 'exited', run: (c, id) => c.stopContainer(id) },
  restart: { verb: 'restarted', status: 'running', run: (c, id) => c.restartContainer(id) },
};

function isLifecycleAction(action: unknown): action is LifecycleAction {
  return action === 'start' || action === 'stop' || action === 'restart';
}

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
      const verdict = await checkDeployQuota(app.teamId, applicationId, app.replicas ?? 1);
      if (!verdict.allowed) {
        return json({ error: verdict.message }, { status: 403 });
      }

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
        return json({ error: result.message }, { status: result.statusCode || 500 });
      }
      return json({ success: true, message: result.message });

    // ──────── START / STOP / RESTART ───────────────────────
    } else if (isLifecycleAction(action)) {
      const lifecycle = LIFECYCLE[action];
      const client = getRestPodmanClient(worker);
      podmanClient = client;

      // Only the generation that is serving. A superseded generation retained
      // for a fast rollback is deliberately stopped, and starting or restarting
      // it here would resurrect the old version's processes without routing any
      // traffic to them.
      const appContainers = await db
        .select()
        .from(containers)
        .where(and(eq(containers.applicationId, applicationId), eq(containers.state, 'active')))
        .all();

      const outcome = await applyToContainers(appContainers, (id) =>
        lifecycle.run(client, id),
      );

      // One statement for everything that took it, rather than one per
      // container — and only for those, so a container Podman refused keeps the
      // status it really has instead of the one that was asked for.
      if (outcome.succeeded.length > 0) {
        await db
          .update(containers)
          .set({ status: lifecycle.status, updatedAt: new Date() })
          .where(inArray(containers.id, outcome.succeeded));
      }

      if (outcome.failures.length > 0) {
        console.error(`[applications] ${action} "${app.name}":`, outcome.failures);
      }

      // 200 even when some containers refused: something did happen, and the
      // message says exactly what. `success` and `failures` are what the caller
      // reads to decide whether to say so in red.
      return json({
        success: outcome.failures.length === 0,
        message: lifecycleMessage(lifecycle.verb, appContainers.length, outcome),
        failures: outcome.failures,
      });

    // ──────────────────────── DELETE ───────────────────────
    } else if (action === 'delete') {
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
        await teardownAppNetwork(podmanClient, applicationId, app.stackId, containerIds, workerSSHConfig);
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

      await db.delete(applications).where(eq(applications.id, applicationId));
      return json({ success: true, message: 'Application deleted' });

    } else {
      return json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Deployment error:', error);
    return json({ error: error.message }, { status: 500 });
  } finally {
    podmanClient?.destroy();
  }
}
