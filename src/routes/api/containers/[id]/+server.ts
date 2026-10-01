import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { isAbsent } from '$lib/server/deploy';
import { requireContainer, route } from '$lib/server/auth';
import { parseJsonBody, schemas } from '$lib/server/validation';
import { redactContainerInspect } from '$lib/server/redact';
import { LockError, withLock, workerDeployLock } from '$lib/server/locks';
import { suppressContainerRestart, restoreContainerRestart } from '$lib/server/runtime-policy';
import { PodmanApiError } from '$lib/server/podman';

export const GET: RequestHandler = route(async (event) => {
  const { container, worker } = await requireContainer(event, event.params.id!);
  // `withPodman` rather than a hand-written destroy: the previous version
  // destroyed the client after a successful inspect and not at all when the
  // inspect threw, so a misbehaving worker leaked a keep-alive TLS agent per
  // request — on exactly the requests most likely to be retried.
  //
  // Redacted because the secrets store injects secrets as environment
  // variables: this returned every secret bound to the container in plaintext,
  // to anyone who could open its page, without the audited reveal the secrets
  // UI requires. See `redactContainerInspect`.
  const inspect = await withPodman(worker, (c) => c.getContainer(container.containerId));
  return json(redactContainerInspect(inspect));
});

/**
 * The four things that can be done to one container, and what each leaves
 * behind in the database.
 *
 * A table rather than an if/else chain, because the chain repeated the same
 * `db.update(...).set({ status, updatedAt })` three times with one word
 * different, and every branch had to remember to destroy the client itself.
 */
const ACTIONS = {
  start: {
    run: (c: PodmanClient, id: string) => c.startContainer(id),
    record: (rowId: string) => setStatus(rowId, 'running'),
  },
  stop: {
    run: (c: PodmanClient, id: string) => c.stopContainer(id),
    record: (rowId: string) => setStatus(rowId, 'exited'),
  },
  restart: {
    run: (c: PodmanClient, id: string) => c.restartContainer(id),
    record: (rowId: string) => setStatus(rowId, 'running'),
  },
  remove: {
    // A container that is already gone is the outcome this asks for, so the row
    // is still deleted. Without this an operator could not clear a row whose
    // container had vanished by any route at all: the generation sweep failed on
    // it every cycle and kept it, and this endpoint — the only other way to
    // remove a record — failed too and left it. The row went on reserving its
    // host port and could not be got rid of short of editing the database.
    run: (c: PodmanClient, id: string) => c.ensureContainerRemoved(id, true).then(() => undefined),
    record: (rowId: string) => recordContainerChange(rowId, null),
  },
} satisfies Record<string, { run: (c: PodmanClient, id: string) => Promise<void>; record: (rowId: string) => unknown }>;

type PodmanClient = Parameters<Parameters<typeof withPodman>[1]>[0];

function setStatus(rowId: string, status: string) {
  return recordContainerChange(rowId, status);
}

function recordContainerChange(rowId: string, status: string | null) {
  db.transaction((tx) => {
    const row = tx.select({ workerId: containers.workerId }).from(containers).where(eq(containers.id, rowId)).get();
    if (status === null) tx.delete(containers).where(eq(containers.id, rowId)).run();
    else tx.update(containers).set({ status, updatedAt: new Date() }).where(eq(containers.id, rowId)).run();
    if (row?.workerId) tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, row.workerId)).run();
  });
}

export const PATCH: RequestHandler = route(async (event) => {
  const { container, worker } = await requireContainer(event, event.params.id!);

  // `schemas.containerAction` already described this shape and went unused; the
  // handler destructured `{ action }` and validated it with an if/else chain
  // whose final `else` was the error message.
  const { action } = await parseJsonBody(event.request, schemas.containerAction);
  const operation = ACTIONS[action];
  const rowId = container.id;

  try {
    return await withLock(workerDeployLock(worker.id), {
      operation: `${action} ${container.name}`,
      holder: crypto.randomUUID(),
    }, async () => {
      // Body parsing may overlap another operation. Use the row protected by
      // this lock, including the new Podman id if recreation just replaced it.
      const container = await db.select().from(containers).where(eq(containers.id, rowId)).get();
      if (!container) return json({ error: 'Container not found' }, { status: 404 });
      if (container.state !== 'active' && (action === 'start' || action === 'restart')) {
        return json({ error: 'This container belongs to a non-active generation. Use rollback or deploy to activate it.' }, { status: 409 });
      }
      if (action !== 'remove') {
        db.transaction((tx) => {
          tx.update(containers).set({ desiredStatus: action === 'stop' ? 'stopped' : 'running' })
            .where(eq(containers.id, container.id)).run();
          tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
            .where(eq(workers.id, worker.id)).run();
        });
      }

      try {
        await withPodman(worker, async (client) => {
          if (action === 'stop' || action === 'remove' || container.state !== 'active') {
            try { await suppressContainerRestart(client, container); }
            catch (error) {
              if (action !== 'remove' || !(error instanceof PodmanApiError) || error.status !== 404) throw error;
            }
          }
          else await restoreContainerRestart(client, container);
          await operation.run(client, container.containerId);
        });
      } catch (e: unknown) {
        // Removing the record of a container the worker does not have is allowed to
        // succeed even if the Podman call fails. `missing` is written only after a
        // container listing that succeeded and did not include this id, so it is
        // better evidence than this one delete's error — and without the exception
        // an operator has no way at all to clear such a row, since the automatic
        // sweep is failing on it for the same reason.
        if (action !== 'remove' || !isAbsent(container.status)) throw e;
        console.warn(
          `[containers] Clearing the record for ${container.name}, which the last container ` +
            `listing did not contain, despite the delete failing:`,
          (e as any)?.message ?? e,
        );
      }
      await operation.record(container.id);

      return json({ success: true, action });
    });
  } catch (error) {
    if (error instanceof LockError) {
      return json({ error: 'Another operation is running on this worker. Try again when it finishes.' }, { status: 409 });
    }
    throw error;
  }
});
