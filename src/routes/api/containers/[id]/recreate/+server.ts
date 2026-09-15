import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';

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

  return withPodman(worker, async (podmanClient) => {
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

    await podmanClient.startContainer(newContainer.Id);

    // Update DB record
    await db
      .update(containers)
      .set({
        containerId: newContainer.Id,
        status: 'running',
        updatedAt: new Date(),
      })
      .where(eq(containers.id, dbContainer.id));

    return json({ success: true, message: 'Container recreated successfully' });
  });
});
