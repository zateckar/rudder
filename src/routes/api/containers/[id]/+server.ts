import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { authErrorResponse, requireContainerAccess } from '$lib/server/auth';

export const GET: RequestHandler = async ({ params, cookies }) => {
  let dbContainer, worker;
  try {
    ({ container: dbContainer, worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
  }

  try {
    const client = getRestPodmanClient(worker);
    const inspect = await client.getContainer(dbContainer.containerId);
    client.destroy();
    return json(inspect);
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  let dbContainer, worker;
  try {
    ({ container: dbContainer, worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
  }

  const body = await request.json();
  const { action } = body;

  let client: ReturnType<typeof getRestPodmanClient>;
  try {
    client = getRestPodmanClient(worker);
  } catch (error: any) {
    return json({ error: error.message }, { status: 400 });
  }

  try {
    if (action === 'start') {
      await client.startContainer(dbContainer.containerId);
      await db.update(containers).set({ status: 'running', updatedAt: new Date() }).where(eq(containers.id, params.id));
    } else if (action === 'stop') {
      await client.stopContainer(dbContainer.containerId);
      await db.update(containers).set({ status: 'exited', updatedAt: new Date() }).where(eq(containers.id, params.id));
    } else if (action === 'restart') {
      await client.restartContainer(dbContainer.containerId);
      await db.update(containers).set({ status: 'running', updatedAt: new Date() }).where(eq(containers.id, params.id));
    } else if (action === 'remove') {
      await client.removeContainer(dbContainer.containerId, true);
      await db.delete(containers).where(eq(containers.id, params.id));
    } else {
      client.destroy();
      return json({ error: 'Invalid action. Use: start, stop, restart, remove' }, { status: 400 });
    }

    client.destroy();
    return json({ success: true, action });
  } catch (error: any) {
    client.destroy();
    return json({ error: error.message }, { status: 500 });
  }
};
