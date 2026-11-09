/**
 * Start, stop and restart an application's serving generation.
 *
 * This lived inline in `/api/applications/deploy`. It moved here when the MCP
 * server needed the same operation: the two callers authenticate differently
 * (a session cookie, a team-mapped bearer token) but must act identically once
 * authorized — the same lock, the same persisted intent, the same restart-policy
 * handling. Two copies of this would drift the way the URL helpers in
 * app-urls.ts did.
 *
 * Authorization is the caller's job. Everything here assumes the caller has
 * already established that the application is theirs to act on.
 */
import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getRestPodmanClient } from './podman-client';
import { applyToContainers, lifecycleMessage, type LifecycleFailure, type LifecycleVerb } from './deploy/lifecycle';
import { withLock, workerDeployLock } from './locks';
import { restoreContainerRestart, suppressContainerRestart } from './runtime-policy';

type PodmanClient = ReturnType<typeof getRestPodmanClient>;

export type LifecycleAction = 'start' | 'stop' | 'restart';

/**
 * The three actions that act on containers already on the worker.
 *
 * One table rather than three near-identical branches: they differed only in
 * the Podman call and the status to write.
 */
const LIFECYCLE: Record<
  LifecycleAction,
  {
    verb: LifecycleVerb;
    /** What the container's status becomes once the call lands. */
    status: string;
    run: (client: PodmanClient, containerId: string) => Promise<void>;
  }
> = {
  start: { verb: 'started', status: 'running', run: (c, id) => c.startContainer(id) },
  stop: { verb: 'stopped', status: 'exited', run: (c, id) => c.stopContainer(id) },
  restart: { verb: 'restarted', status: 'running', run: (c, id) => c.restartContainer(id) },
};

export function isLifecycleAction(action: unknown): action is LifecycleAction {
  return action === 'start' || action === 'stop' || action === 'restart';
}

export type LifecycleResult =
  | { found: false }
  | { found: true; success: boolean; message: string; failures: LifecycleFailure[] };

/**
 * Apply `action` to the application's active containers, under the worker's
 * deploy lock.
 *
 * Throws `LockError` when another operation holds the worker; callers turn that
 * into their own "busy" answer. Returns `{ found: false }` when the application
 * was deleted while the lock was being acquired.
 */
export async function runLifecycleAction(
  app: { id: string; name: string },
  worker: typeof workers.$inferSelect,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  return withLock(workerDeployLock(worker.id), {
    operation: `${action} ${app.name}`,
    holder: crypto.randomUUID(),
  }, async () => {
    if (!db.select({ id: applications.id }).from(applications).where(eq(applications.id, app.id)).get()) {
      return { found: false } as const;
    }
    const lifecycle = LIFECYCLE[action];

    // Only the generation that is serving. A superseded generation retained
    // for a fast rollback is deliberately stopped, and starting or restarting
    // it here would resurrect the old version's processes without routing any
    // traffic to them.
    const appContainers = await db
      .select()
      .from(containers)
      .where(and(eq(containers.applicationId, app.id), eq(containers.state, 'active')))
      .all();

    // Persist the request before contacting Podman, including failed stops.
    // A status sweep may change what is observed, never what was requested.
    const desiredStatus = action === 'stop' ? 'stopped' : 'running';
    db.transaction((tx) => {
      tx.update(applications).set({ desiredStatus, updatedAt: new Date() })
        .where(eq(applications.id, app.id)).run();
      tx.update(containers).set({ desiredStatus: null })
        .where(and(eq(containers.applicationId, app.id), eq(containers.state, 'active'))).run();
      tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
        .where(eq(workers.id, worker.id)).run();
    });

    const client = getRestPodmanClient(worker);
    try {
      const outcome = await applyToContainers(appContainers, async (id) => {
        const row = appContainers.find((container) => container.containerId === id)!;
        if (action === 'stop') await suppressContainerRestart(client, row);
        else await restoreContainerRestart(client, row);
        await lifecycle.run(client, id);
      });

      // One statement for everything that took it, rather than one per
      // container — and only for those, so a container Podman refused keeps the
      // status it really has instead of the one that was asked for.
      if (outcome.succeeded.length > 0) {
        db.transaction((tx) => {
          tx.update(containers).set({ status: lifecycle.status, updatedAt: new Date() })
            .where(inArray(containers.id, outcome.succeeded)).run();
          tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
            .where(eq(workers.id, worker.id)).run();
        });
      }

      if (outcome.failures.length > 0) {
        console.error(`[applications] ${action} "${app.name}":`, outcome.failures);
      }

      return {
        found: true,
        success: outcome.failures.length === 0,
        message: lifecycleMessage(lifecycle.verb, appContainers.length, outcome),
        failures: outcome.failures,
      } as const;
    } finally {
      // Each client carries a keep-alive HTTPS agent; one dropped rather than
      // destroyed leaks its sockets to the worker for the life of the process.
      client.destroy();
    }
  });
}
