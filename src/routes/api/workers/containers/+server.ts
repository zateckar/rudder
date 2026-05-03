import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createPodmanClient, type PodmanClient } from '$lib/server/podman';

function getPodmanClient(worker: typeof workers.$inferSelect): { client: PodmanClient; useRestApi: boolean } | null {
  if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
    return {
      client: createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      }),
      useRestApi: true,
    };
  }

  if (worker.podmanApiUrl) {
    // Dev/local mode — no mTLS
    return {
      client: createPodmanClient({ apiUrl: worker.podmanApiUrl }),
      useRestApi: true,
    };
  }

  return null;
}

export async function GET({ url, cookies, locals }: { url: URL; cookies: any; locals: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (locals.userRole !== 'admin') {
    return json({ error: 'Forbidden - admin access required' }, { status: 403 });
  }

  const workerId = url.searchParams.get('workerId');

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();

  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    const result = getPodmanClient(worker);
    if (!result) {
      return json({ error: 'No Podman client available — worker not yet provisioned' }, { status: 400 });
    }

    const { client } = result;
    const containers = await client.listContainers(true);

    client.destroy();

    return json(containers);
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
}
