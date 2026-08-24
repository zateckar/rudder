import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume, runningContainerNames } from '$lib/server/app-volumes';
import { cloneVolume, restoreFromCopy } from '$lib/server/volume-ops';
import { LockError, withLock, workerDeployLock } from '$lib/server/locks';
import { parseVolumeCopyName } from '$lib/server/volumes';

/**
 * Hold the worker's deploy lock for the duration of `fn`.
 *
 * Both operations in this file rewrite a volume a deploy may be about to mount,
 * so they contend for the same lock a deploy does. A held lock is a 409 with its
 * own sentence rather than `LockError`'s, which names the internal key.
 */
async function withWorkerLock<T>(
  workerId: string,
  workerName: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return {
      ok: true,
      value: await withLock(
        workerDeployLock(workerId),
        { operation, holder: `${process.pid}:${crypto.randomUUID()}` },
        fn,
      ),
    };
  } catch (e) {
    if (e instanceof LockError) {
      return {
        ok: false,
        response: json(
          {
            error:
              `A deploy is already running on worker "${workerName}". Volume operations and ` +
              `deploys are run one at a time so neither writes under the other. Try again once ` +
              `it finishes.`,
          },
          { status: 409 },
        ),
      };
    }
    throw e;
  }
}

/**
 * Take a copy of a volume, on the worker.
 *
 * The cheap safety net before a risky change: nothing leaves the worker, so it
 * costs a `cp -a` and the disk it occupies. A copy is named
 * `rudder-copy-<app8>-…` and nothing runs on it — see `volumeCopyName`, which
 * explains why that namespace can never be confused with a volume in service.
 *
 * Not refused while the application runs. A copy of a live volume carries the
 * same caveat as any live backup, and refusing to take one is worse than taking
 * one that may be mid-write. Restoring it *is* refused; see `PUT` below.
 */
export const POST: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { worker, volume, copyOf } = await requireAppVolume(application, event.params.name!);

  if (copyOf) {
    return json(
      { error: `"${volume.name}" is already a copy. Copy "${copyOf.name}" instead.` },
      { status: 400 },
    );
  }

  if (!volume.present) {
    return json(
      {
        error:
          `"${volume.name}" does not exist on worker "${worker.name}" yet. A volume is created ` +
          `the first time a container mounts it, so deploy the application first.`,
      },
      { status: 409 },
    );
  }

  const result = await withWorkerLock(worker.id, worker.name, `copy volume ${volume.name}`, () =>
    cloneVolume(worker, application.id, volume.name, Date.now()),
  );
  if (!result.ok) return result.response;

  return json({
    success: true,
    name: result.value,
    message: `Copied "${volume.name}" to "${result.value}".`,
  });
});

/**
 * Put a copy back over the volume it was taken from.
 *
 * Addressed by the *copy's* name, which is what the UI has to hand. Same guard
 * as a tar restore, for the same reason — this overwrites live data — and always
 * a replacement: a copy exists to return to a known state, and merging one over
 * whatever is there now gives a state that never existed.
 */
export const PUT: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { worker, volume, copyOf } = await requireAppVolume(application, event.params.name!);

  if (!copyOf) {
    return json(
      {
        error:
          `"${volume.name}" is a volume, not a copy of one. Restore one of its copies onto it, ` +
          `or upload an archive.`,
      },
      { status: 400 },
    );
  }

  const running = await runningContainerNames(application.id);
  if (running.length > 0) {
    return json(
      {
        error:
          `Stop "${application.name}" before restoring. Writing over "${copyOf.name}" while ` +
          `${running.map((n) => `"${n}"`).join(', ')} ${running.length === 1 ? 'is' : 'are'} ` +
          `running can leave the data in a state that never existed.`,
        running,
      },
      { status: 409 },
    );
  }

  const result = await withWorkerLock(
    worker.id,
    worker.name,
    `restore volume ${copyOf.name}`,
    () => restoreFromCopy(worker, application.id, volume.name, copyOf.name),
  );
  if (!result.ok) return result.response;

  const takenAt = parseVolumeCopyName(volume.name)?.at;
  return json({
    success: true,
    message:
      `Restored "${copyOf.name}" from the copy taken` +
      `${takenAt ? ` on ${new Date(takenAt).toLocaleString()}` : ''}. ` +
      `Start the application to use it.`,
  });
});
