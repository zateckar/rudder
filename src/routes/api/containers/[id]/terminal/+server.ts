import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createPodmanClient, type PodmanClient } from '$lib/server/podman';

function getPodmanClient(worker: typeof workers.$inferSelect): { client: PodmanClient } | null {
  if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
    return {
      client: createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      }),
    };
  }
  return null;
}

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const containerId = params.id;

  const container = await db.select().from(containers).where(eq(containers.id, containerId)).get();

  if (!container || !container.workerId) {
    return json({ error: 'Container not found or no worker assigned' }, { status: 404 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, container.workerId)).get();

  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  const result = getPodmanClient(worker);

  if (!result) {
    return json({ error: 'No Podman client available — worker not yet provisioned with mTLS credentials' }, { status: 400 });
  }

  const { client } = result;

  try {
    const logs = await client.getContainerLogs(container.containerId, {
      stdout: true,
      stderr: true,
      tail: 500,
      timestamps: true,
    });

    return new Response(logs, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e: any) {
    return json({ error: e.message }, { status: 500 });
  }
}
