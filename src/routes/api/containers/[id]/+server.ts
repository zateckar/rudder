import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
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
    run: (c: PodmanClient, id: string) => c.removeContainer(id, true),
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

  await withPodman(worker, (client) => operation.run(client, container.containerId));
  await operation.record(container.id);

  return json({ success: true, action });
});
