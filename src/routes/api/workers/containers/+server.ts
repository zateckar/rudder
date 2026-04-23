import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey } from '$lib/server/ssh';
import { createPodmanClient, createSSHPodmanClient, type PodmanClient, type SSHPodmanClient } from '$lib/server/podman';

function getPodmanClient(worker: typeof workers.$inferSelect): { client: PodmanClient | SSHPodmanClient; useRestApi: boolean } | null {
  // Try REST API first if credentials are available
  if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
    return {
      client: createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      }),
      useRestApi: true
    };
  }

  return null;
}

async function getPodmanClientWithSSH(worker: typeof workers.$inferSelect) {
  // Try REST API first
  const restClient = getPodmanClient(worker);
  if (restClient) {
    return restClient;
  }

  // Fall back to SSH
  if (worker.sshKeyId) {
    const sshKey = await getSSHKey(worker.sshKeyId);
    if (sshKey) {
      return {
        client: createSSHPodmanClient({
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        }),
        useRestApi: false
      };
    }
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

  // Require admin role
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
    const result = await getPodmanClientWithSSH(worker);
    if (!result) {
      return json({ error: 'No Podman client available' }, { status: 400 });
    }

    const { client } = result;
    const containers = await client.listContainers(true);
    
    client.destroy();
    
    return json(containers);
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
}
