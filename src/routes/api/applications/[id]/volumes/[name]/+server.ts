import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume, runningContainerNames } from '$lib/server/app-volumes';
import { withPodman } from '$lib/server/podman-client';
import { PodmanApiError } from '$lib/server/podman';

/**
 * Delete a volume and everything written to it.
 *
 * Deleting a volume used to mean deleting the registry *row*, leaving the data
 * on the worker under a name nothing referred to any more — and the confirmation
 * dialog said so, which made the entire feature a way to lose track of disk
 * rather than reclaim it. This removes the volume itself.
 *
 * `?force=1` is the caller's explicit override for Podman's "still in use"
 * refusal; without it a 409 comes back with Podman's own sentence, which is
 * actionable. `?registry=1` additionally drops the `volumes` row, for a
 * registry-backed volume the user is finished with entirely — kept separate
 * because deleting data and deleting a declaration are different intentions.
 *
 * A volume that is not this application's alone — one belonging to another
 * application by name, or a bare compose name a second application declares — is
 * refused by `requireAppVolume` before any of that. There is no undo.
 */
export const DELETE: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const name = event.params.name!;
  const { worker, volume } = await requireAppVolume(application, name, 'delete');

  const force = event.url.searchParams.get('force') === '1';
  const alsoRegistry = event.url.searchParams.get('registry') === '1';

  // What Podman did, not what the snapshot in `requireAppVolume` predicted. The
  // two can disagree — a volume created since it was taken, a volume removed by
  // hand — and reporting the prediction meant a delete that destroyed something
  // could answer "there was nothing to delete".
  let removed: boolean;
  try {
    removed = await withPodman(worker, (client) => client.removeVolume(volume.name, force));
  } catch (e) {
    // Podman refuses with 409 while a container still mounts the volume. Saying
    // so explicitly is what lets the UI offer the override *only* here: every
    // other refusal on this route is also a 409 — a volume shared with another
    // application, one belonging to another application — and forcing would
    // neither help nor be safe.
    if (!force && e instanceof PodmanApiError && e.status === 409) {
      return json({ error: e.detail, canForce: true }, { status: 409 });
    }
    throw e;
  }

  if (alsoRegistry && volume.registryId) {
    await db.delete(volumes).where(eq(volumes.id, volume.registryId));
  }

  const registryNote =
    alsoRegistry && volume.registryId ? ' Its registry entry has been removed as well.' : '';

  return json({
    success: true,
    removed,
    message: removed
      ? `Deleted volume "${volume.name}".${registryNote}`
      : `No volume had been created for "${volume.label}" yet, so there was nothing to ` +
        `delete on worker "${worker.name}".${registryNote}`,
  });
});

/**
 * What is currently mounting this volume, for the confirmation dialog.
 *
 * Cheap enough to ask before a destructive action, and the answer is what the
 * user needs in order to decide: a running container named here is one whose
 * data is about to go.
 *
 * The one caller that passes no action: this reads the application's own view of
 * a volume it declares and touches no contents, so the shared-volume refusal
 * would only stop the user finding out *why* the delete beside it is refused. A
 * volume belonging to another application is still refused — that check is about
 * ownership rather than intent, and this would otherwise report its size and
 * mount point.
 *
 * Sizes are asked for here because displaying them is the whole purpose.
 */
export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { volume, copyOf } = await requireAppVolume(application, event.params.name!, null, {
    sizes: true,
  });

  return json({
    volume,
    copyOf: copyOf?.name ?? null,
    running: await runningContainerNames(application.id),
  });
});
