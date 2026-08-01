import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers, containers, deployments, deployWebhooks, applicationTemplates } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { executeApplicationDeploy, resolveWorkerSSHConfig } from '$lib/server/deploy';
import { teardownAppNetwork } from '$lib/server/networks';
import { canAccessApplication } from '$lib/server/auth';
import { checkDeployQuota } from '$lib/server/quota';


export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const body = await request.json();
  const { applicationId, action } = body;

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

  try {
    // ──────────────────────── DEPLOY ────────────────────────
    if (action === 'deploy') {
      const verdict = await checkDeployQuota(app.teamId, applicationId, app.replicas ?? 1);
      if (!verdict.allowed) {
        return json({ error: verdict.message }, { status: 403 });
      }

      const deployUserId = ctx.user.id;

      const result = await executeApplicationDeploy(applicationId, deployUserId);
      if (!result.success) {
        return json({ error: result.message }, { status: result.statusCode || 500 });
      }
      return json({ success: true, message: result.message });

    // ──────────────────────── START ────────────────────────
    } else if (action === 'start') {
      const podmanClient = getRestPodmanClient(worker);
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, applicationId))
        .all();

      for (const container of appContainers) {
        try {
          await podmanClient.startContainer(container.containerId);
          await db.update(containers)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(containers.id, container.id));
        } catch (e: any) {
          console.error('Failed to start container:', e);
        }
      }
      return json({ success: true, message: 'Application started' });

    // ──────────────────────── STOP ─────────────────────────
    } else if (action === 'stop') {
      const podmanClient = getRestPodmanClient(worker);
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, applicationId))
        .all();

      for (const container of appContainers) {
        try {
          await podmanClient.stopContainer(container.containerId);
          await db.update(containers)
            .set({ status: 'exited', updatedAt: new Date() })
            .where(eq(containers.id, container.id));
        } catch (e: any) {
          console.error('Failed to stop container:', e);
        }
      }
      return json({ success: true, message: 'Application stopped' });

    // ──────────────────────── RESTART ──────────────────────
    } else if (action === 'restart') {
      const podmanClient = getRestPodmanClient(worker);
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, applicationId))
        .all();

      for (const container of appContainers) {
        try {
          await podmanClient.restartContainer(container.containerId);
          await db.update(containers)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(containers.id, container.id));
        } catch (e: any) {
          console.error('Failed to restart container:', e);
        }
      }
      return json({ success: true, message: 'Application restarted' });

    // ──────────────────────── DELETE ───────────────────────
    } else if (action === 'delete') {
      const podmanClient = getRestPodmanClient(worker);
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
  }
}
