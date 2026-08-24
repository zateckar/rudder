import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume, runningContainerNames } from '$lib/server/app-volumes';
import { restoreVolume, type RestoreMode } from '$lib/server/volume-ops';
import { PodmanApiError } from '$lib/server/podman';
import { LockError, VOLUME_OP_TTL_MS, withLock, workerDeployLock } from '$lib/server/locks';

/**
 * Write a tar archive back into a volume.
 *
 * The destructive one. Three guards, all refusals rather than warnings:
 *
 * - **The volume must be this application's alone.** `requireAppVolume` refuses
 *   a volume another application declares — `replace` force-removes and
 *   recreates it, so on a shared name this would destroy a second application's
 *   data, and the running-container check below cannot see *their* containers.
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
  const { worker, volume } = await requireAppVolume(application, event.params.name!, 'restore');

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
        // The upload is the client's, so this is bounded by their link speed and
        // the archive's size, not by anything here. The deploy-sized default
        // expires under a large restore and lets a deploy run beside it.
        ttlMs: VOLUME_OP_TTL_MS,
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
    if (e instanceof PodmanApiError) throw e;

    // Still a 500 — this is a genuine fault and must not be relabelled — but with
    // a body, and one that says what state the data is in. `replace` recreates the
    // volume before extracting, so a failure past that point leaves it empty, and
    // the archive that would have filled it was the request body: it is gone, and
    // the caller is the only one who still has a copy. Letting `route()` produce
    // a bare 500 meant the page could not even parse the response, and reported a
    // JSON syntax error for the loss of a database.
    const detail = e instanceof Error ? e.message : String(e);
    return json(
      {
        error:
          mode === 'replace'
            ? `Restoring "${volume.name}" failed after the volume had been emptied, so it is now ` +
              `empty and the archive was not applied. Upload it again once the cause is fixed — ` +
              `Rudder does not keep a copy. The failure was: ${detail}`
            : `Merging the archive into "${volume.name}" failed partway through, so it may hold a ` +
              `mixture of old and new files. The failure was: ${detail}`,
      },
      { status: 500 },
    );
  }

  return json({
    success: true,
    message:
      mode === 'replace'
        ? `Restored "${volume.name}" from the archive. Start the application to use it.`
        : `Merged the archive into "${volume.name}". Start the application to use it.`,
  });
});
