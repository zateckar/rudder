import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import {
  otherAppsUsing,
  requireAppVolume,
  runningContainerNames,
} from '$lib/server/app-volumes';
import { withPodman } from '$lib/server/podman-client';

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
 */
export const DELETE: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const name = event.params.name!;
  const { worker, volume } = await requireAppVolume(application, name);

  const force = event.url.searchParams.get('force') === '1';
  const alsoRegistry = event.url.searchParams.get('registry') === '1';

  // A bare compose volume name (`pgdata:/data`) is not namespaced to the
  // application — `parseCompose` passes it through as written — so it may be
  // another application's data as well. Refused by name rather than deleted
  // with a warning: there is no undo.
  if (volume.origin === 'shared') {
    const others = await otherAppsUsing(volume.name, application.id, worker);
    if (others.length > 0) {
      return json(
        {
          error:
            `"${volume.name}" is not scoped to this application — it is also used by ` +
            `${others.map((n) => `"${n}"`).join(', ')} on worker "${worker.name}". Deleting it ` +
            `would delete their data too. Rename the volume in one of the manifests first.`,
        },
        { status: 409 },
      );
    }
  }

  await withPodman(worker, (client) => client.removeVolume(volume.name, force));

  if (alsoRegistry && volume.registryId) {
    await db.delete(volumes).where(eq(volumes.id, volume.registryId));
  }

  return json({
    success: true,
    message: alsoRegistry && volume.registryId
      ? `Deleted volume "${volume.name}" and its registry entry.`
      : `Deleted volume "${volume.name}".`,
  });
});

/**
 * What is currently mounting this volume, for the confirmation dialog.
 *
 * Cheap enough to ask before a destructive action, and the answer is what the
 * user needs in order to decide: a running container named here is one whose
 * data is about to go.
 */
export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { volume, copyOf } = await requireAppVolume(application, event.params.name!);

  return json({
    volume,
    copyOf: copyOf?.name ?? null,
    running: await runningContainerNames(application.id),
  });
});
