import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';
import { LockError, withLock, workerDeployLock } from '$lib/server/locks';
import { suppressContainerRestart, restoreContainerRestart } from '$lib/server/runtime-policy';

/**
 * Recreate a container from its own inspected config, to apply new resource
 * limits without a full deploy.
 *
 * **Not a way to pick up a new image.** This rebuilds from `podman inspect`,
 * not from the application's deployment plan, so it drops the healthcheck, the
 * network mode and aliases, the tmpfs that carries secret mounts and the files
 * delivered into it — and it copies `Config.Cmd`/`Config.Entrypoint`, which are
 * the *old* image's resolved defaults, onto whatever image it creates. It also
 * writes no deployment row, so nothing records what ran. The UI used to offer
 * this as an "Update" button next to each container; it was removed, because
 * `/api/applications/deploy` is the path that pulls the tag fresh, blue/greens,
 * verifies health and records the digest.
 *
 * `pullImage` therefore defaults to **false**: a call that does not ask for a
 * new image must not silently swap one in. A pull that fails is still only
 * warned about — `createContainer` falls back to the copy already on the worker
 * — which is the other reason this must not be anyone's update mechanism.
 */
export const POST: RequestHandler = route(async (event) => {
  const { container: dbContainer, worker } = await requireContainer(event, event.params.id!);

  const body = await event.request.json().catch(() => ({}));
  const pullImage = body.pullImage ?? false;
  const memory = body.memory;
  const cpuQuota = body.cpuQuota;
  const cpuPeriod = body.cpuPeriod;
  const rowId = dbContainer.id;

  try {
    return await withLock(workerDeployLock(worker.id), {
      operation: `recreate ${dbContainer.name}`,
      holder: crypto.randomUUID(),
    }, () => withPodman(worker, async (podmanClient) => {
      // A Stop may have completed while the request body was being read.
      const dbContainer = await db.select().from(containers).where(eq(containers.id, rowId)).get();
      if (!dbContainer) return json({ error: 'Container not found' }, { status: 404 });
      const app = dbContainer.applicationId
        ? await db.select({ desiredStatus: applications.desiredStatus }).from(applications)
            .where(eq(applications.id, dbContainer.applicationId)).get()
        : null;
      const shouldStart = dbContainer.state === 'active' && (dbContainer.desiredStatus ?? app?.desiredStatus ?? 'running') === 'running';
      // Inspect current container to get config
      const inspectData = await podmanClient.getContainer(dbContainer.containerId);
      const oldConfig = inspectData.Config;
      const oldHostConfig = inspectData.HostConfig;

      // Optionally pull the latest image first
      if (pullImage) {
        try {
          await podmanClient.pullImage(oldConfig.Image);
        } catch (e: any) {
          console.warn(`Failed to pull image ${oldConfig.Image}:`, e.message);
        }
      }

      // Stop and remove the old container
      if (inspectData.State.Running) {
        await podmanClient.stopContainer(dbContainer.containerId, 10);
      }
      await podmanClient.removeContainer(dbContainer.containerId, true);

      // Rebuild port bindings
      const ports: Record<string, Array<{ hostPort: string }>> = {};
      if (oldHostConfig.PortBindings) {
        for (const [port, bindings] of Object.entries(oldHostConfig.PortBindings)) {
          ports[port] = bindings.map((b) => ({ hostPort: b.HostPort }));
        }
      }

      // Create the replacement container with same config (+ optional new limits)
      const newContainer = await podmanClient.createContainer({
        name: inspectData.Name.replace(/^\//, ''),
        image: oldConfig.Image,
        env: oldConfig.Env,
        labels: oldConfig.Labels,
        command: oldConfig.Cmd,
        entrypoint: oldConfig.Entrypoint,
        workingDir: oldConfig.WorkingDir,
        restartPolicy: oldHostConfig.RestartPolicy?.Name,
        ports: Object.keys(ports).length > 0 ? ports : undefined,
        binds: oldHostConfig.Binds,
        memory: memory !== undefined ? memory : oldHostConfig.Memory,
        cpuPeriod: cpuPeriod !== undefined ? cpuPeriod : oldHostConfig.CpuPeriod,
        cpuQuota: cpuQuota !== undefined ? cpuQuota : oldHostConfig.CpuQuota,
      });

      // Bind the new worker marker to the new identity before claiming success.
      db.transaction((tx) => {
        tx.update(containers).set({
          containerId: newContainer.Id,
          status: 'created',
          updatedAt: new Date(),
        }).where(eq(containers.id, dbContainer.id)).run();
        tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
          .where(eq(workers.id, worker.id)).run();
      });
      const replacement = { ...dbContainer, containerId: newContainer.Id };
      if (shouldStart) await restoreContainerRestart(podmanClient, replacement);
      else await suppressContainerRestart(podmanClient, replacement);
      if (shouldStart) {
        await podmanClient.startContainer(newContainer.Id);
        db.transaction((tx) => {
          tx.update(containers).set({ status: 'running', updatedAt: new Date() }).where(eq(containers.id, dbContainer.id)).run();
          tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
            .where(eq(workers.id, worker.id)).run();
        });
      }

      return json({ success: true, message: 'Container recreated successfully' });
    }));
  } catch (error) {
    if (error instanceof LockError) {
      return json({ error: 'Another operation is running on this worker. Try again when it finishes.' }, { status: 409 });
    }
    throw error;
  }
});
