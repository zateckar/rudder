import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications, volumes, teamMembers, workers } from '$lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { AuthorizationError, requireUser, route } from '$lib/server/auth';
import { withPodman } from '$lib/server/podman-client';
import { registryVolumeName } from '$lib/server/volumes';

/**
 * Resolve a volume the caller may act on.
 *
 * The membership check used to be written `role !== 'admin' && volume.teamId`,
 * which skips it entirely when the volume has no team — so every volume created
 * without one (the POST route allowed that) was readable, editable and deletable
 * by any authenticated user. A teamless volume is now admin-only: it belongs to
 * nobody, so nobody but an operator should reach it.
 *
 * Reading and writing are the same permission now. They were split by the team
 * `owner` role, which no longer exists: a team is flat, so a member who can see a
 * volume can change it — the same rule that already governed the applications
 * those volumes are mounted into.
 *
 * 404 for a volume the caller cannot see at all — another team's, or a teamless
 * one — so the route does not double as an id oracle.
 */
async function requireVolume(
  event: { locals: App.Locals },
  volumeId: string,
): Promise<typeof volumes.$inferSelect> {
  const ctx = requireUser(event);

  const volume = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  if (!volume) throw new AuthorizationError('Volume not found', 404);

  if (ctx.user.role !== 'admin') {
    if (!volume.teamId) throw new AuthorizationError('Volume not found', 404);

    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, ctx.user.id)))
      .get();

    if (!membership) throw new AuthorizationError('Volume not found', 404);
  }

  return volume;
}

export const GET: RequestHandler = route(async (event) => {
  return json(await requireVolume(event, event.params.id!));
});

export const PATCH: RequestHandler = route(async (event) => {
  const volumeId = event.params.id!;
  await requireVolume(event, volumeId);

  const body = await event.request.json();
  const allowedFields = ['name', 'containerPath', 'sizeLimit', 'workerId'] as const;
  const updates: Record<string, any> = { updatedAt: new Date() };

  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  await db.update(volumes).set(updates).where(eq(volumes.id, volumeId));

  const updated = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  return json(updated);
});

/**
 * Remove a volume from the registry, and optionally its data.
 *
 * The row and the data are two different things, and this endpoint used to
 * delete only the row — leaving the Podman volume on the worker under a name
 * nothing referred to any more. That is still the default, because it is what
 * "remove this entry" means and because the row may be referenced by an
 * application that is only temporarily undeployed.
 *
 * `?data=1` also deletes the volume itself, on every worker where an application
 * referencing this row put one. A registered volume is namespaced per
 * application — `rudder-<app8>-<name>` — so there can be several, and each has
 * to be named explicitly rather than guessed at from the row's own name.
 */
export const DELETE: RequestHandler = route(async (event) => {
  const volumeId = event.params.id!;
  const volume = await requireVolume(event, volumeId);
  const alsoData = event.url.searchParams.get('data') === '1';

  const removed: string[] = [];
  const failed: string[] = [];

  if (alsoData) {
    for (const target of await podmanTargetsFor(volume)) {
      try {
        await withPodman(target.worker, (client) =>
          // Not forced: a volume a container still mounts is a refusal the
          // caller should see rather than something to override on their behalf.
          client.removeVolume(target.podmanName, false),
        );
        removed.push(target.podmanName);
      } catch (e) {
        failed.push(
          `${target.podmanName} on "${target.worker.name}": ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // The row goes even when a volume could not be removed: the two are separate,
  // and the message says exactly what happened to each.
  await db.delete(volumes).where(eq(volumes.id, volumeId));

  if (failed.length > 0) {
    return json(
      {
        success: false,
        message:
          `Removed the registry entry for "${volume.name}", but its data could not be deleted: ` +
          `${failed.join('; ')}. Stop whatever is using it and delete the volume from the ` +
          `application's Storage tab.`,
      },
      { status: 409 },
    );
  }

  return json({
    success: true,
    message: alsoData
      ? removed.length > 0
        ? `Deleted "${volume.name}" and its data (${removed.join(', ')}).`
        : `Removed the registry entry for "${volume.name}". No volume had been created for it yet.`
      : `Removed the registry entry for "${volume.name}". Its data is still on the worker.`,
  });
});

/**
 * Every Podman volume this registry row has produced, with the worker it is on.
 *
 * Driven from the applications referencing the row rather than from
 * `volumes.worker_id`, which is advisory — "Any worker" is a valid value — while
 * the volume itself exists wherever the application that mounts it was deployed.
 */
async function podmanTargetsFor(
  volume: typeof volumes.$inferSelect,
): Promise<{ worker: typeof workers.$inferSelect; podmanName: string }[]> {
  const apps = await db
    .select({ id: applications.id, workerId: applications.workerId, volumes: applications.volumes })
    .from(applications)
    .all();

  const targets: { workerId: string; podmanName: string }[] = [];
  for (const app of apps) {
    if (!app.workerId || !app.volumes) continue;
    let declared: unknown;
    try {
      declared = JSON.parse(app.volumes);
    } catch {
      continue;
    }
    if (!Array.isArray(declared)) continue;
    if (!declared.some((e) => (e as { volumeId?: string })?.volumeId === volume.id)) continue;
    targets.push({ workerId: app.workerId, podmanName: registryVolumeName(app.id, volume.name) });
  }

  if (targets.length === 0) return [];

  const workerRows = await db
    .select()
    .from(workers)
    .where(inArray(workers.id, [...new Set(targets.map((t) => t.workerId))]))
    .all();
  const workerById = new Map(workerRows.map((w) => [w.id, w]));

  return targets.flatMap((t) => {
    const worker = workerById.get(t.workerId);
    return worker?.podmanApiUrl ? [{ worker, podmanName: t.podmanName }] : [];
  });
}
