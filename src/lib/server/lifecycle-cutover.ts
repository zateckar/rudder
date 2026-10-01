import { db } from '$lib/db';
import { applications, containers, deployments, workers } from '$lib/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

/** All role changes and their crash-recovery marker commit in one SQLite transaction. */
export function commitGenerationCutover(
  workerId: string,
  promoteIds: string[],
  demoteIds: string[],
  deploymentId?: string,
  applicationId?: string,
  desiredStatus: 'running' | 'stopped' = 'running',
): Date {
  const now = new Date();
  db.transaction((tx) => {
    if (demoteIds.length) tx.update(containers)
      .set({ state: 'draining', retainedAt: now, drainConfigHash: null, updatedAt: now })
      .where(inArray(containers.id, demoteIds)).run();
    if (promoteIds.length) tx.update(containers)
      .set({ state: 'active', desiredStatus: null, retainedAt: null, drainConfigHash: null, updatedAt: now })
      .where(inArray(containers.id, promoteIds)).run();
    tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
    if (deploymentId) tx.update(deployments).set({ cutoverAt: now })
      .where(eq(deployments.id, deploymentId)).run();
    if (applicationId) tx.update(applications).set({ desiredStatus, updatedAt: now })
      .where(eq(applications.id, applicationId)).run();
  });
  return now;
}

/** A failed candidate remains pending until routing exclusion is acknowledged. */
export function revertGenerationCutover(workerId: string, restoreIds: string[], candidateIds: string[], deploymentId?: string, applicationId?: string, desiredStatus: 'running' | 'stopped' = 'running'): void {
  const now = new Date();
  db.transaction((tx) => {
    if (candidateIds.length) tx.update(containers)
      .set({ state: 'pending', retainedAt: null, updatedAt: now })
      .where(inArray(containers.id, candidateIds)).run();
    if (restoreIds.length) tx.update(containers)
      .set({ state: 'active', retainedAt: null, drainConfigHash: null, updatedAt: now })
      .where(inArray(containers.id, restoreIds)).run();
    tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
    if (deploymentId) tx.update(deployments).set({ cutoverAt: null })
      .where(eq(deployments.id, deploymentId)).run();
    if (applicationId) tx.update(applications).set({ desiredStatus, updatedAt: now })
      .where(eq(applications.id, applicationId)).run();
  });
}

/** Failed rollback restores the original overrides and retention deadlines. */
export function revertRetainedGenerationCutover(
  workerId: string,
  applicationId: string,
  desiredStatus: 'running' | 'stopped',
  previous: Array<Pick<typeof containers.$inferSelect, 'id' | 'desiredStatus'>>,
  candidate: Array<Pick<typeof containers.$inferSelect, 'id' | 'desiredStatus' | 'retainedAt' | 'updatedAt'>>,
): void {
  db.transaction((tx) => {
    for (const row of previous) tx.update(containers)
      .set({ state: 'active', desiredStatus: row.desiredStatus, retainedAt: null, drainConfigHash: null })
      .where(eq(containers.id, row.id)).run();
    for (const row of candidate) tx.update(containers)
      .set({ state: 'draining', desiredStatus: row.desiredStatus, retainedAt: row.retainedAt ?? row.updatedAt, drainConfigHash: null })
      .where(eq(containers.id, row.id)).run();
    tx.update(applications).set({ desiredStatus }).where(eq(applications.id, applicationId)).run();
    tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
  });
}
