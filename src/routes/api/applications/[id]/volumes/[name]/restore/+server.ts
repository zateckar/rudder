import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume, runningContainerNamesLive } from '$lib/server/app-volumes';
import { restoreVolume, type RestoreMode } from '$lib/server/volume-ops';
import { PodmanApiError } from '$lib/server/podman';
import { LockError, VOLUME_OP_TTL_MS, withLock, workerDeployLock } from '$lib/server/locks';

/**
 * Carries the refusal out through `withLock`, whose callback can only signal by
 * throwing. Distinct from every other error the block can produce, so the 409
 * below cannot swallow a genuine failure and report it as "stop the app".
 */
class ContainersRunning extends Error {
  constructor(readonly running: string[]) {
    super(`${running.length} container(s) still running`);
    this.name = 'ContainersRunning';
  }
}

/**
 * A failure of the pre-flight check itself, before the volume has been touched.
 *
 * Needed because the catch below reports a `replace` failure as "the volume has
 * been emptied and your archive was not applied" — true of anything that fails
 * inside `restoreVolume`, and a false alarm about data loss if the thing that
 * failed was asking the worker what is running. Same reason the check fails
 * closed: an unreachable worker is not evidence that nothing is running.
 */
class PreflightFailed extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PreflightFailed';
  }
}

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
 * - **The worker's deploy lock is held for the duration**, so a deploy cannot
 *   recreate containers onto the volume halfway through the extraction.
 * - **Nothing of the application may be running** — asked of the worker, inside
 *   that lock. A restore overwrites files under whatever has them open; on a
 *   database that produces a corrupt store rather than the state that was
 *   backed up. The refusal names the containers to stop, because that is the
 *   next thing the user has to do.
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
      async () => {
        // Inside the lock, and asked of the worker rather than of the database.
        //
        // Outside it, this was two races at once. The check read
        // `containers.status`, which the fleet sweep writes once a collection
        // interval, so a container started in the last minute — or the last
        // hour, at the interval an operator is allowed to set — still read
        // `exited` and the restore proceeded over a live database. And even a
        // live check made before acquiring the lock could be overtaken by a
        // deploy starting containers in the gap. Holding the lock first means
        // nothing can start them between the answer and the extraction.
        let running: string[];
        try {
          running = await runningContainerNamesLive(worker, application.id);
        } catch (e) {
          throw new PreflightFailed(e);
        }
        if (running.length > 0) throw new ContainersRunning(running);

        return restoreVolume(worker, application.id, volume.name, body, mode);
      },
    );
  } catch (e) {
    if (e instanceof ContainersRunning) {
      return json(
        {
          error:
            `Stop "${application.name}" before restoring. Writing over ` +
            `"${volume.name}" while ${e.running.map((n) => `"${n}"`).join(', ')} ` +
            `${e.running.length === 1 ? 'is' : 'are'} running can leave the data in a state that ` +
            `never existed.`,
          running: e.running,
        },
        { status: 409 },
      );
    }
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
    if (e instanceof PreflightFailed) {
      return json(
        {
          error:
            `Could not check whether "${application.name}" is still running on worker ` +
            `"${worker.name}", so the restore was not attempted — "${volume.name}" is untouched ` +
            `and your archive was not applied. Restoring over running containers can corrupt the ` +
            `data, so this refuses rather than guesses. The failure was: ${e.message}`,
        },
        { status: 502 },
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
