import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume, runningContainerNames } from '$lib/server/app-volumes';
import { restoreVolume, type RestoreMode } from '$lib/server/volume-ops';
import { LockError, withLock, workerDeployLock } from '$lib/server/locks';

/**
 * Write a tar archive back into a volume.
 *
 * The destructive one. Two guards, both refusals rather than warnings:
 *
 * - **Nothing of the application may be running.** A restore overwrites files
 *   under whatever has them open; on a database that produces a corrupt store
 *   rather than the state that was backed up. The refusal names the containers
 *   to stop, because that is the next thing the user has to do.
 * - **The worker's deploy lock is held for the duration**, so a deploy cannot
 *   recreate containers onto the volume halfway through the extraction.
 *
 * `?mode=replace` (the default) recreates the volume first, so the result is
 * exactly the archive. `?mode=merge` extracts over what is there — occasionally
 * what you want, for dropping a config directory back without touching the data
 * beside it, and never what you want for a restore.
 */
export const POST: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { worker, volume } = await requireAppVolume(application, event.params.name!);

  const requested = event.url.searchParams.get('mode') ?? 'replace';
  if (requested !== 'replace' && requested !== 'merge') {
    return json(
      { error: `Unknown restore mode "${requested}". Use "replace" or "merge".` },
      { status: 400 },
    );
  }
  const mode = requested as RestoreMode;

  const running = await runningContainerNames(application.id);
  if (running.length > 0) {
    return json(
      {
        error:
          `Stop "${application.name}" before restoring. Writing over ` +
          `"${volume.name}" while ${running.map((n) => `"${n}"`).join(', ')} ` +
          `${running.length === 1 ? 'is' : 'are'} running can leave the data in a state that ` +
          `never existed.`,
        running,
      },
      { status: 409 },
    );
  }

  const body = event.request.body;
  if (!body) {
    return json({ error: 'No archive was uploaded.' }, { status: 400 });
  }

  try {
    await withLock(
      workerDeployLock(worker.id),
      {
        operation: `restore volume ${volume.name}`,
        holder: `${process.pid}:${crypto.randomUUID()}`,
      },
      () => restoreVolume(worker, application.id, volume.name, body, mode),
    );
  } catch (e) {
    if (e instanceof LockError) {
      return json(
        {
          error:
            `A deploy is already running on worker "${worker.name}". Restoring while it recreates ` +
            `containers would write under them, so the two are run one at a time. Try again once ` +
            `it finishes.`,
        },
        { status: 409 },
      );
    }
    throw e;
  }

  return json({
    success: true,
    message:
      mode === 'replace'
        ? `Restored "${volume.name}" from the archive. Start the application to use it.`
        : `Merged the archive into "${volume.name}". Start the application to use it.`,
  });
});
