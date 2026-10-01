/**
 * Repair the state a deploy leaves behind when the process dies mid-flight.
 *
 * Everything that runs a deploy handles its own failures: `executeApplication
 * Deploy` marks the deployment `failed` and discards the generation it created.
 * None of that runs when the process itself goes — SIGKILL, an OOM, a restart
 * during a deploy. What is left is a `deployments` row stuck at `pending`
 * forever and a `containers` generation stuck at `pending`, and nothing looked
 * at either again: the reconciler does not route to a pending container, no
 * cutover will ever promote it, and the expiry sweep only considers `draining`
 * rows. The application went on serving its previous generation while the
 * history showed a deploy still in progress, and the abandoned containers held
 * their host ports out of the allocator until somebody redeployed by hand.
 *
 * The in-memory locks do not have this problem — they die with the process,
 * which is the correct outcome — so this is only about rows.
 */

import { db } from '$lib/db';
import { deployments, workers } from '$lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { sweepInterruptedGenerations } from './deploy';
import { synchronizeWorkerRuntimePolicies } from './runtime-policy';

/**
 * Fail every deployment still marked `pending`, and discard what it created.
 *
 * Safe to do unconditionally *because it runs at startup*: a deploy only ever
 * runs in this process — the locks that serialize deploys are a plain in-memory
 * Map, so the design is single-process throughout — and at boot none is in
 * flight. Every `pending` row therefore belongs to a process that is gone. The
 * same statement at any other moment would fail a running deploy, which is why
 * this is called once from `hooks.server.ts` and not from the metrics loop.
 *
 * The container sweep it triggers is not once-only for the opposite reason: it
 * needs to reach the worker, which may be down at boot, so it also runs on the
 * metrics interval and retries there. This first call is just the fast path.
 */
export async function recoverInterruptedDeploys(): Promise<{
  failedDeployments: number;
  discardedContainers: number;
}> {
  const failedDeployments = recoverInterruptedDeploymentHistory();

  let discardedContainers = 0;
  for (const worker of db.select({ id: workers.id }).from(workers).all()) {
    try { await synchronizeWorkerRuntimePolicies(worker.id); }
    catch (error) { console.warn('[recover] Worker boot intent synchronization will retry:', error); }
  }
  try {
    // Runs after the statement above on purpose — that is what moves the
    // deployment off `pending`, which is the signal the sweep tests for.
    ({ reaped: discardedContainers } = await sweepInterruptedGenerations());
  } catch (e: any) {
    console.error('[recover] Could not discard interrupted generations:', e?.message ?? e);
  }

  return { failedDeployments, discardedContainers };
}

/** Startup-only history repair; committed cutover survives even if finalization did not. */
export function recoverInterruptedDeploymentHistory(): number {
  let failedDeployments = 0;

  try {
    const stranded = db
      .select({ id: deployments.id, applicationId: deployments.applicationId, version: deployments.version, cutoverAt: deployments.cutoverAt })
      .from(deployments)
      .where(or(eq(deployments.status, 'pending'), eq(deployments.status, 'running')))
      .all();

    for (const row of stranded) {
      db
        .update(deployments)
        .set({
          status: 'failed',
          // The operator reading the history needs to know this deploy did not
          // fail on its merits — nothing was wrong with the manifest, and the
          // previous version is still the one serving.
          errorMessage: row.cutoverAt
            ? 'Interrupted after committed cutover: the new generation remains active. Previous containers are retained until the worker acknowledges routing installation. Check application health before retrying.'
            : 'Interrupted before a committed generation switch was recorded. Check application health and retry. Abandoned candidate cleanup waits for acknowledged routing exclusion.',
          finishedAt: new Date(),
        })
        .where(eq(deployments.id, row.id)).run();
      failedDeployments += 1;
    }

    if (failedDeployments > 0) {
      console.warn(
        `[recover] Marked ${failedDeployments} deployment(s) failed — they were still ` +
          `running when the control plane last stopped.`,
      );
    }
  } catch (e: any) {
    // Startup must not depend on this: a panel that will not boot is worse than
    // one showing a stale deploy.
    console.error('[recover] Could not reconcile interrupted deployments:', e?.message ?? e);
  }

  return failedDeployments;
}
