import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AuthorizationError, requireApplication, route } from '#lib/server/auth.ts';
import { assertNotSharedWithOthers, assertVolumeRestoreIdle, requireAppVolume, VolumeInUseError } from '#lib/server/app-volumes.ts';
import { restoreVolume, VolumeRestoreError, type RestoreMode } from '#lib/server/volume-ops.ts';
import { PodmanApiError } from '#lib/server/podman.ts';
import { LockError, VOLUME_OP_TTL_MS, withLock, workerDeployLock } from '#lib/server/locks.ts';

/**
 * Write a tar archive back into a volume.
 *
 * The destructive one. Three guards, all refusals rather than warnings:
 *
 * - **The volume must be this application's alone.** `requireAppVolume` refuses
 *   a volume another application uses.
 *
 * - **The worker's deploy lock is held for the duration**, so a deploy cannot
 *   recreate containers onto the volume halfway through the extraction.
 * - **Nothing of the application may be running** — asked of the worker, inside
 *   that lock. A restore overwrites files under whatever has them open; on a
 *   database that produces a corrupt store rather than the state that was
 *   backed up. The refusal names the containers to stop, because that is the
 *   next thing the user has to do.
 *
 * `?mode=replace` (the default) stages the archive and saves the previous contents.
 * `?mode=merge` extracts over the existing files.
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
        ttlMs: VOLUME_OP_TTL_MS,
      },
      async () => {
        const { application: current } = await requireApplication(event, application.id);
        if (current.workerId !== worker.id) throw new AuthorizationError('Worker assignment changed. Retry the restore.', 409);
        await assertNotSharedWithOthers(current, worker, volume, 'restore');
        const checkIdle = () => assertVolumeRestoreIdle(current, worker, volume.name);
        await checkIdle();
        return restoreVolume(worker, application.id, volume.name, body, mode, checkIdle);
      },
    );
  } catch (e) {
    if (e instanceof VolumeInUseError) {
      return json({ error: e.message, running: e.running }, { status: e.statusCode });
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
    if (e instanceof VolumeRestoreError) {
      return json({ error: e.message, recoveryVolume: e.recoveryVolume }, { status: 500 });
    }
    if (e instanceof AuthorizationError) throw e;
    if (e instanceof PodmanApiError) throw e;

    const detail = e instanceof Error ? e.message : String(e);
    return json(
      {
        error: mode === 'replace'
          ? `Could not prepare to replace "${volume.name}". Its contents were preserved. ${detail}`
          : `Merging the archive into "${volume.name}" failed. It may hold a mixture of old and new files. ${detail}`,
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
