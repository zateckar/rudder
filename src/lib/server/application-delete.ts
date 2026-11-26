import { db } from '#lib/db/index.ts';
import { applications, applicationTemplates, containers, deployments, deployWebhooks, workers } from '#lib/db/schema.ts';
import { eq, inArray, sql } from 'drizzle-orm';
import { DomainReservationError, withApplicationDeletionDomains } from './domains';
import { LockError, withLock, workerDeployLock } from './locks';
import { appNetworkName } from './networks';
import { withPodman } from './podman-client';

type ApplicationTarget = Pick<typeof applications.$inferSelect, 'id' | 'name' | 'teamId' | 'workerId'>;
type DeleteResult = { ok: true } | { ok: false; status: 404 | 409 | 502; message: string };

/** The caller has already checked access to the application. */
export async function deleteApplication(app: ApplicationTarget): Promise<DeleteResult> {
  const tracked = () => db.select().from(containers).where(eq(containers.applicationId, app.id)).all();
  const workerIds = new Set(tracked().map((row) => row.workerId));
  if (app.workerId) workerIds.add(app.workerId);
  if (workerIds.has(null)) {
    return { ok: false, status: 502, message: 'A container has no worker assignment. Its removal cannot be confirmed.' };
  }
  const targets = [...workerIds].filter((id): id is string => id !== null).sort();
  const remove = () => withApplicationDeletionDomains(app.id, async (): Promise<DeleteResult> => {
    const current = db.select().from(applications).where(eq(applications.id, app.id)).get();
    if (!current || current.teamId !== app.teamId) return { ok: false, status: 404, message: 'Application not found' };
    const rows = tracked();
    if (current.workerId !== app.workerId || rows.some((row) => !workerIds.has(row.workerId))) {
      return { ok: false, status: 409, message: 'The worker assignment changed. Retry deletion.' };
    }
    for (const workerId of targets) {
      const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
      const ids = new Set(rows.filter((row) => row.workerId === workerId).map((row) => row.containerId));
      if (worker && !worker.podmanApiUrl && ids.size === 0) continue;
      if (!worker) return { ok: false, status: 502, message: 'A worker record is missing. Container removal cannot be confirmed.' };
      try {
        await withPodman(worker, async (client) => {
          for (const id of ids) await client.ensureContainerRemoved(id, true);
          await client.removeNetwork(appNetworkName(app.id));
        });
      } catch (error) {
        console.error(`[applications] Could not complete deletion of "${app.name}" on worker "${worker.name}":`, error);
        return { ok: false, status: 502, message: `Could not confirm cleanup on worker "${worker.name}". Retry deletion when the worker is reachable.` };
      }
    }

    // Keep the app and all retry information until every worker confirms
    // removal. If the process stops before this commit, Podman 404s make the
    // next attempt idempotent.
    db.transaction((tx) => {
      tx.delete(containers).where(eq(containers.applicationId, app.id)).run();
      tx.delete(deployments).where(eq(deployments.applicationId, app.id)).run();
      tx.delete(deployWebhooks).where(eq(deployWebhooks.applicationId, app.id)).run();
      tx.update(applicationTemplates).set({ sourceAppId: null }).where(eq(applicationTemplates.sourceAppId, app.id)).run();
      tx.delete(applications).where(eq(applications.id, app.id)).run();
      if (targets.length > 0) {
        tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
          .where(inArray(workers.id, targets)).run();
      }
    });
    return { ok: true };
  });

  const run = targets.reduceRight<() => Promise<DeleteResult>>((next, id) => (
    () => withLock(workerDeployLock(id), { operation: `delete ${app.name}` }, next)
  ), remove);
  try {
    return await run();
  } catch (error) {
    if (error instanceof LockError || error instanceof DomainReservationError) {
      return { ok: false, status: 409, message: 'Another application operation is running. Retry deletion when it finishes.' };
    }
    throw error;
  }
}
