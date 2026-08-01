import { json } from '@sveltejs/kit';
import { workers } from '$lib/db/schema';
import { createPodmanClient, type PodmanClient } from '$lib/server/podman';
import { authErrorResponse, requireContainerAccess } from '$lib/server/auth';

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
  let container, worker;
  try {
    ({ container, worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
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
