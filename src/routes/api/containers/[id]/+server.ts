import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { isAbsent } from '$lib/server/deploy';
import { requireContainer, route } from '$lib/server/auth';
import { parseJsonBody, schemas } from '$lib/server/validation';

export const GET: RequestHandler = route(async (event) => {
  const { container, worker } = await requireContainer(event, event.params.id!);
  // `withPodman` rather than a hand-written destroy: the previous version
  // destroyed the client after a successful inspect and not at all when the
  // inspect threw, so a misbehaving worker leaked a keep-alive TLS agent per
  // request — on exactly the requests most likely to be retried.
  return json(await withPodman(worker, (c) => c.getContainer(container.containerId)));
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
    record: (rowId: string) => db.delete(containers).where(eq(containers.id, rowId)),
  },
} satisfies Record<string, { run: (c: PodmanClient, id: string) => Promise<void>; record: (rowId: string) => unknown }>;

type PodmanClient = Parameters<Parameters<typeof withPodman>[1]>[0];

function setStatus(rowId: string, status: string) {
  return db
    .update(containers)
    .set({ status, updatedAt: new Date() })
    .where(eq(containers.id, rowId));
}

export const PATCH: RequestHandler = route(async (event) => {
  const { container, worker } = await requireContainer(event, event.params.id!);

  // `schemas.containerAction` already described this shape and went unused; the
  // handler destructured `{ action }` and validated it with an if/else chain
  // whose final `else` was the error message.
  const { action } = await parseJsonBody(event.request, schemas.containerAction);
  const operation = ACTIONS[action];

  try {
    await withPodman(worker, (client) => operation.run(client, container.containerId));
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
