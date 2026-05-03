import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createPodmanClient } from '$lib/server/podman';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const since = url.searchParams.get('since') || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const type = url.searchParams.get('type'); // container, image, pod, system, volume
  const container = url.searchParams.get('container');

  try {
    const filters: Record<string, string[]> = {};
    if (type) filters.type = [type];
    if (container) filters.container = [container];

    let events: any[] = [];

    if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      const client = createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      });
      events = await client.events(since, undefined, Object.keys(filters).length > 0 ? filters : undefined);
      client.destroy();
    } else if (worker.podmanApiUrl) {
      // Dev/local mode — no mTLS
      const client = createPodmanClient({ apiUrl: worker.podmanApiUrl });
      events = await client.events(since, undefined, Object.keys(filters).length > 0 ? filters : undefined);
      client.destroy();
    }

    return json({ events, count: events.length });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
