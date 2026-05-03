import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { SSHPodmanClient } from '$lib/server/podman';

export const POST: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  // Parse optional ad-hoc SSH key from request body (never stored server-side)
  let sshPrivateKey: string | undefined;
  try {
    const body = await request.json();
    sshPrivateKey = body?.sshPrivateKey;
  } catch {
    // No body or invalid JSON — will fall back to REST API if configured
  }

  let status: 'online' | 'offline' | 'error' = 'offline';
  let errorMessage: string | null = null;

  try {
    if (sshPrivateKey) {
      // Use ad-hoc SSH key for reconnect (key is never stored)
      const client = new SSHPodmanClient({
        host: worker.hostname,
        port: worker.sshPort,
        username: worker.sshUser,
        privateKey: sshPrivateKey,
      });

      // List containers as a connectivity test
      await client.listContainers();
      status = 'online';
    } else if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      // Fall back to Podman REST API with mTLS if credentials are configured
      const { PodmanClient } = await import('$lib/server/podman');
      const client = new PodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      });

      await client.listContainers();
      status = 'online';
    } else {
      errorMessage = 'No SSH key provided and no Podman API credentials configured. Provide an SSH key to reconnect via SSH.';
      status = 'error';
    }
  } catch (error: any) {
    status = 'error';
    errorMessage = error.message || 'Connection failed';
  }

  // Update worker status
  await db.update(workers).set({
    status,
    lastSeenAt: status === 'online' ? new Date() : worker.lastSeenAt,
  }).where(eq(workers.id, params.id));

  return json({
    success: status === 'online',
    status,
    error: errorMessage,
    lastSeenAt: status === 'online' ? new Date().toISOString() : worker.lastSeenAt?.toISOString(),
  });
};
