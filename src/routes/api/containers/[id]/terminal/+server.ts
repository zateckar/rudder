import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, executeSSHCommand } from '$lib/server/ssh';
import { createPodmanClient, createSSHPodmanClient, type PodmanClient, type SSHPodmanClient } from '$lib/server/podman';

function getPodmanClient(worker: typeof workers.$inferSelect): { client: PodmanClient | SSHPodmanClient; useRestApi: boolean } | null {
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
  const restClient = getPodmanClient(worker);
  if (restClient) {
    return restClient;
  }

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

  const result = await getPodmanClientWithSSH(worker);

  if (!result) {
    return json({ error: 'No Podman client available' }, { status: 400 });
  }

  const { client, useRestApi } = result;

  if (!useRestApi) {
    const sshClient = client as SSHPodmanClient;
    try {
      const output = await sshClient.getContainerLogs(container.containerId, {
        stdout: true,
        stderr: true,
        tail: 500,
      });
      
      return new Response(output, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (e: any) {
      return json({ error: e.message }, { status: 500 });
    }
  }

  const podmanClient = client as PodmanClient;

  try {
    const logs = await podmanClient.getContainerLogs(container.containerId, {
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
