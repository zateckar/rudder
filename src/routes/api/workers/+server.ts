import { json } from '@sveltejs/kit';
import { db, safeWorkerColumns } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { parseJsonBody, schemas } from '$lib/server/validation';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  // `safeWorkerColumns`, not `select()`. A bare select returned the encrypted
  // Podman client key, the CrowdSec bouncer key, the OIDC client secret and
  // encryption key, and the worker's config token to every caller of this
  // endpoint. Admin-only is not a reason to serialise credentials — it decides
  // who can ask, not what a stolen session walks away with. Every page load()
  // already uses this; this endpoint was the one bypass.
  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();
  return json(allWorkers);
});

export const POST: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const { name, hostname, sshPort, sshUser, baseDomain, labels } = await parseJsonBody(
    event.request,
    schemas.createWorker,
  );

  const workerId = crypto.randomUUID();

  await db.insert(workers).values({
    id: workerId,
    name,
    hostname,
    sshPort,
    sshUser,
    podmanApiUrl: `ssh://${hostname}:${sshPort}`,
    status: 'provisioning',
    createdAt: new Date(),
    baseDomain,
    labels: labels ? JSON.stringify(labels) : null,
  });

  return json({ id: workerId, status: 'provisioning' });
});
