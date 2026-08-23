import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand } from '$lib/server/ssh';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

export const POST: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  // Parse optional ad-hoc SSH key from request body (never stored server-side)
  let sshPrivateKey: string | undefined;
  try {
    const body = await event.request.json();
    sshPrivateKey = body?.sshPrivateKey;
  } catch {
    // No body or invalid JSON — will fall back to REST API if configured
  }

  let status: 'online' | 'offline' | 'error' = 'offline';
  let errorMessage: string | null = null;

  try {
    if (sshPrivateKey) {
      // Ad-hoc key, never stored. `podman ps` is the probe: it proves both that
      // SSH works and that podman is installed and answering, which is what
      // "reconnect" is being asked. Its output is discarded — a non-zero exit
      // is the whole signal.
      const probe = await executeSSHCommand(
        {
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshPrivateKey,
        },
        'podman ps -a --format json',
      );
      if (probe.exitCode !== 0) {
        throw new Error(probe.stderr.trim() || `podman ps exited ${probe.exitCode}`);
      }
      status = 'online';
    } else if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      // Fall back to the Podman REST API over mTLS when credentials exist.
      const client = getRestPodmanClient(worker);
      try {
        await client.listContainers();
        status = 'online';
      } finally {
        // The keep-alive agent holds its TLS sockets open for the life of the
        // process otherwise; this client used to be dropped, not destroyed.
        client.destroy();
      }
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
  }).where(eq(workers.id, workerId));

  return json({
    success: status === 'online',
    status,
    error: errorMessage,
    lastSeenAt: status === 'online' ? new Date().toISOString() : worker.lastSeenAt?.toISOString(),
  });
});
