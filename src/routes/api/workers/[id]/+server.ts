import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, safeWorkerColumns } from '$lib/db';
import { workers, applications, containers, volumes, workerMetrics, workerPings } from '$lib/db/schema';
import { eq, count } from 'drizzle-orm';
import { requireWorker, route } from '$lib/server/auth';
import { evictPodmanClient } from '$lib/server/podman-client';

/**
 * A worker as the browser may see it.
 *
 * `safeWorkerColumns` is the list that says which columns those are, and it is
 * the same one every page load uses. This route used to hand-roll the redaction
 * — `podmanClientKey: undefined` plus two `'***'` placeholders — which meant it
 * had its own opinion about which columns are secret, and that opinion had
 * already fallen behind: `crowdsecBouncerKey`, `oidcClientSecret`,
 * `oidcEncryptionKey` and `configToken` were all returned in full.
 */
function publicWorker(worker: typeof workers.$inferSelect) {
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(safeWorkerColumns)) {
    safe[key] = (worker as Record<string, unknown>)[key];
  }
  // Kept as presence flags, which is what the worker page renders.
  safe.podmanCaCert = worker.podmanCaCert ? '***' : null;
  safe.podmanClientCert = worker.podmanClientCert ? '***' : null;
  return safe;
}

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  return json(publicWorker(worker));
});

export const PATCH: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  await requireWorker(event, workerId);

  const body = await event.request.json();
  const allowedFields = ['name', 'hostname', 'sshPort', 'sshUser', 'labels', 'status'] as const;
  const updates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  await db.update(workers).set(updates).where(eq(workers.id, workerId));

  const updated = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  return json(updated ? publicWorker(updated) : { error: 'Worker not found' });
});

export const DELETE: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  await requireWorker(event, workerId);

  // Counts, not rows: this loaded every application, container and volume on
  // the worker in full — manifests included — to find out whether any existed.
  const [apps, conts, vols] = await Promise.all([
    db.select({ n: count() }).from(applications).where(eq(applications.workerId, workerId)).get(),
    db.select({ n: count() }).from(containers).where(eq(containers.workerId, workerId)).get(),
    db.select({ n: count() }).from(volumes).where(eq(volumes.workerId, workerId)).get(),
  ]);

  if ((apps?.n ?? 0) > 0 || (conts?.n ?? 0) > 0 || (vols?.n ?? 0) > 0) {
    return json({
      error: 'Cannot delete worker with existing applications, containers, or volumes',
      applications: apps?.n ?? 0,
      containers: conts?.n ?? 0,
      volumes: vols?.n ?? 0,
    }, { status: 409 });
  }

  // Delete related data that should be cleaned up
  await db.delete(workerMetrics).where(eq(workerMetrics.workerId, workerId));
  await db.delete(workerPings).where(eq(workerPings.workerId, workerId));

  await db.delete(workers).where(eq(workers.id, workerId));

  // The pooled client keeps TLS sockets open to a machine Rudder no longer
  // manages. Nothing else will ever notice: the cache is keyed on the worker id
  // and the row that would refresh it is gone.
  evictPodmanClient(workerId);

  return json({ success: true, message: 'Worker deleted' });
});
