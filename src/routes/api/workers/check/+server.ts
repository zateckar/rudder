import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey } from '$lib/server/ssh';
import { createPodmanClient, createSSHPodmanClient } from '$lib/server/podman';

export async function POST({ request, cookies, locals }: { request: Request; cookies: any; locals: any }) {
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

  const body = await request.json();
  const { workerId } = body;

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    let isOnline = false;
    let useRestApi = false;

    // Try REST API first if credentials are available
    if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      try {
        const podmanClient = createPodmanClient({
          apiUrl: worker.podmanApiUrl,
          caCert: worker.podmanCaCert,
          clientCert: worker.podmanClientCert,
          clientKey: worker.podmanClientKey,
        });

        isOnline = await podmanClient.ping();
        useRestApi = true;
        podmanClient.destroy();
      } catch (e) {
        console.warn('REST API check failed, trying SSH:', e);
      }
    }

    // Fall back to SSH if REST API is not available
    if (!isOnline && worker.sshKeyId) {
      const sshKey = await getSSHKey(worker.sshKeyId);
      if (sshKey) {
        const sshClient = createSSHPodmanClient({
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        });

        isOnline = await sshClient.ping();
        sshClient.destroy();
      }
    }
    
    if (isOnline) {
      await db.update(workers)
        .set({ 
          status: 'online',
          lastSeenAt: new Date(),
        })
        .where(eq(workers.id, workerId));
    } else {
      await db.update(workers)
        .set({ status: 'offline' })
        .where(eq(workers.id, workerId));
    }
    
    return json({ online: isOnline, useRestApi });
  } catch (error: any) {
    console.error('Worker check error:', error);
    await db.update(workers)
      .set({ status: 'error' })
      .where(eq(workers.id, workerId));
    
    return json({ online: false, error: error.message }, { status: 500 });
  }
}
