import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export const POST: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  try {
    if (!worker.podmanApiUrl) {
      return json({ error: 'Prune requires REST API connection' }, { status: 400 });
    }
    const client = getRestPodmanClient(worker);

    const result = await client.systemPrune(true);
    client.destroy();

    return json({ success: true, result });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
