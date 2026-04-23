import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbContainer = await db.select().from(containers).where(eq(containers.id, params.id)).get();
  if (!dbContainer) return json({ error: 'Container not found' }, { status: 404 });

  const worker = await db.select().from(workers).where(eq(workers.id, dbContainer.workerId!)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

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
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbContainer = await db.select().from(containers).where(eq(containers.id, params.id)).get();
  if (!dbContainer) return json({ error: 'Container not found' }, { status: 404 });

  const worker = await db.select().from(workers).where(eq(workers.id, dbContainer.workerId!)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const body = await request.json();
  const { action } = body;

  try {
    const client = getRestPodmanClient(worker);

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
    return json({ error: error.message }, { status: 500 });
  }
};
