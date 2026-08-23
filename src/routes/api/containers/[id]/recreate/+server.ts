import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';

export const POST: RequestHandler = route(async (event) => {
  const { container: dbContainer, worker } = await requireContainer(event, event.params.id!);

  const body = await event.request.json().catch(() => ({}));
  const pullImage = body.pullImage ?? true;
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
