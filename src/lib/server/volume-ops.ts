/**
 * Backing up, restoring and copying a named volume's contents.
 *
 * Podman has no export or import for volumes — a volume is a directory the
 * runtime owns, and the API exposes nothing that reads it. The only way in is
 * through a container that mounts it, which is exactly what `docker cp` does:
 * `/containers/{id}/archive` reads and writes tar against a container's
 * filesystem, mounts included.
 *
 * So every operation here runs a throwaway container with the volume attached,
 * does one thing, and removes it. That container is the whole mechanism, and
 * `withVolumeHelper` is the only place its lifecycle is written — a helper left
 * behind on a failed backup would hold the volume open and block the delete the
 * user reaches for next.
 *
 * Nothing here decides *whether* an operation is allowed. Whether the
 * application is stopped, whether the volume is shared with another
 * application, and who is asking are the routes' business; this module assumes
 * the answer is yes.
 */
import type http from 'http';
import type { workers } from '$lib/db/schema';
import { env } from './env';
import { realizeMounts, type MountIntent } from './mounts';
import type { PodmanClient } from './podman';
import { getRestPodmanClient, withPodman } from './podman-client';
// The labels come from `reconcile`, which is what reads them back: a helper is
// labelled so `mayRemove` permits cleaning one up and so `isTransientHelper` can
// keep a mid-operation helper out of the drift report.
import { APP_ID_LABEL, HELPER_ROLE, MANAGED_LABEL, ROLE_LABEL } from './reconcile';
import { COPY_SOURCE_LABEL, volumeCopyName } from './volumes';

/** Where a helper sees the volume it is working on. */
const MOUNT_AT = '/volume';
/** Clone source and destination, kept apart so `cp -a` cannot recurse into itself. */
const CLONE_FROM = '/from';
const CLONE_TO = '/to';

/**
 * Keep the helper alive without depending on `sleep infinity`, which BusyBox
 * does not accept everywhere. A backup of a large volume can outlast any single
 * sleep, so it loops.
 */
const IDLE_CMD = ['sh', '-c', 'while :; do sleep 3600; done'];

/**
 * Run `fn` against a container that has `mounts` attached, and always remove it.
 *
 * `createContainer` pulls the image itself, so there is no separate pull step —
 * and it fails loudly when the image is neither pullable nor already present,
 * which is the right outcome: a backup that silently did not happen is worse
 * than one that errored.
 *
 * `force: true` on the remove because the helper is still running when `fn`
 * returns; there is nothing in it worth a graceful stop.
 */
async function withVolumeHelper<T>(
  client: PodmanClient,
  appId: string,
  mounts: MountIntent[],
  command: string[],
  fn: (containerId: string) => Promise<T>,
): Promise<T> {
  const { binds, tmpfs } = realizeMounts(mounts);
  const name = `rudder-volhelper-${crypto.randomUUID().slice(0, 12)}`;

  const created = await client.createContainer({
    name,
    image: env.VOLUME_TOOL_IMAGE,
    command,
    binds,
    tmpfs,
    restartPolicy: 'no',
    // `rudder.managed` so `mayRemove` permits cleaning one up, and `rudder.role`
    // so the reconciler can tell it apart from a container that is supposed to be
    // serving. Without the role it matched the orphan rule exactly — managed,
    // carrying an application id, and never in the `containers` table — and every
    // operation long enough to span a reconcile cycle raised drift. See
    // `isTransientHelper`.
    labels: {
      [MANAGED_LABEL]: 'true',
      [APP_ID_LABEL]: appId,
      [ROLE_LABEL]: HELPER_ROLE,
    },
  });

  try {
    await client.startContainer(created.Id);
    return await fn(created.Id);
  } finally {
    // Best-effort: the operation's own error is the one worth reporting, and a
    // failure to clean up must not replace it.
    try {
      await client.removeContainer(created.Id, true);
    } catch (e) {
      console.warn(`[volume-ops] Could not remove helper container ${name}:`, e);
    }
  }
}

/**
 * Stream a volume's contents out as tar.
 *
 * Returns the live response *and* the client, because neither may be disposed of
 * until the caller has finished reading — which is why this does not use
 * `withPodman`. `release` removes the helper and destroys the client; the caller
 * must call it when the stream ends or fails.
 *
 * Entries come back prefixed `volume/`, being the basename of the mount point.
 * That is deliberate and is what makes the round trip work: `restoreVolume`
 * extracts relative to `/`, so `volume/...` lands back in the mount.
 */
export async function backupVolume(
  worker: typeof workers.$inferSelect,
  appId: string,
  volumeName: string,
): Promise<{ stream: http.IncomingMessage; release: () => Promise<void> }> {
  // Not `withPodman`: neither the client nor the helper container may be
  // disposed of until the caller has finished reading the stream.
  const client = getRestPodmanClient(worker);

  const { binds, tmpfs } = realizeMounts([
    { kind: 'volume', name: volumeName, target: MOUNT_AT, mode: 'ro' },
  ]);
  const name = `rudder-volhelper-${crypto.randomUUID().slice(0, 12)}`;

  let containerId: string | null = null;
  const release = async () => {
    if (containerId) {
      try {
        await client.removeContainer(containerId, true);
      } catch (e) {
        console.warn(`[volume-ops] Could not remove helper container ${name}:`, e);
      }
    }
    client.destroy();
  };

  try {
    const created = await client.createContainer({
      name,
      image: env.VOLUME_TOOL_IMAGE,
      command: IDLE_CMD,
      binds,
      tmpfs,
      restartPolicy: 'no',
      labels: {
        'rudder.managed': 'true',
        'rudder.app.id': appId,
        'rudder.role': 'volume-helper',
      },
    });
    containerId = created.Id;
    // Started rather than merely created: whether an archive read sees a
    // container's volume mounts before it has ever run is version-dependent, and
    // a backup that quietly returned the image's empty directory instead of the
    // volume would not look like a failure.
    await client.startContainer(containerId);
    const stream = await client.getArchiveStream(containerId, MOUNT_AT);
    return { stream, release };
  } catch (e) {
    await release();
    throw e;
  }
}

export type RestoreMode = 'replace' | 'merge';

/**
 * Write a tar back into a volume.
 *
 * `replace` removes and recreates the volume before extracting, which is the
 * only way to get a *restore* rather than an overlay: extracting a tar leaves
 * every file the archive does not mention exactly where it was, so a merge onto
 * a live database directory can produce a state that never existed. Recreating
 * the volume is also how the wipe avoids a shell — there is no `rm -rf` here to
 * get the quoting wrong.
 *
 * `merge` is offered because it is occasionally what you want: dropping a
 * config directory back in without touching the data beside it.
 */
export async function restoreVolume(
  worker: typeof workers.$inferSelect,
  appId: string,
  volumeName: string,
  archive: ReadableStream<Uint8Array>,
  mode: RestoreMode,
): Promise<void> {
  await withPodman(worker, async (client) => {
    if (mode === 'replace') {
      // Before anything is destroyed. `withVolumeHelper` would pull the image
      // itself, but that happens *after* the wipe, so a worker that cannot reach
      // the registry — or that Rudder's own prune has just taken the image off —
      // ended up with an emptied volume and the archive never applied. The upload
      // stream is gone by then; there is nothing to retry with.
      await client.ensureImage(env.VOLUME_TOOL_IMAGE);

      // Force, because the caller has already established that nothing of the
      // application's is running; anything still holding it is not ours.
      await client.removeVolume(volumeName, true);
      await client.createVolume(volumeName);
    }

    await withVolumeHelper(
      client,
      appId,
      [{ kind: 'volume', name: volumeName, target: MOUNT_AT, mode: 'rw' }],
      IDLE_CMD,
      // Extracted at `/`, so the `volume/` prefix `backupVolume` produced lands
      // back inside the mount point.
      (id) => client.putArchiveStream(id, '/', archive),
    );
  });
}

/**
 * Copy one volume's contents into another, on the worker.
 *
 * `cp -a` rather than tar through the control plane: the data never leaves the
 * worker, which is the point of having this alongside a download. `-a` preserves
 * ownership, modes and timestamps — without it a copy is present but not
 * restorable, because the process that reads it back no longer owns its files.
 *
 * Additive, exactly like extracting a tar: it does not remove what the source
 * does not mention. Callers wanting a replacement recreate the target first.
 */
async function copyVolumeContents(
  client: PodmanClient,
  appId: string,
  from: string,
  to: string,
): Promise<void> {
  await withVolumeHelper(
    client,
    appId,
    [
      { kind: 'volume', name: from, target: CLONE_FROM, mode: 'ro' },
      { kind: 'volume', name: to, target: CLONE_TO, mode: 'rw' },
    ],
    // `/from/.` rather than `/from`: copying the directory itself would produce
    // `/to/from/…`.
    ['sh', '-c', `cp -a ${CLONE_FROM}/. ${CLONE_TO}/`],
    async (id) => {
      const exitCode = await client.waitContainer(id);
      if (exitCode === 0) return;

      // The copy's own words are the only useful diagnosis — a permission
      // error, a full disk — so they go into the message rather than the log.
      let output = '';
      try {
        output = (
          await client.getContainerLogs(id, { stdout: true, stderr: true, tail: 20 })
        ).trim();
      } catch {
        // Nothing readable; the exit code has to carry it alone.
      }
      throw new Error(
        `Copying "${from}" to "${to}" failed (exit ${exitCode})${output ? `: ${output}` : '.'}`,
      );
    },
  );
}

/**
 * Take a point-in-time copy of a volume. Returns the copy's name.
 *
 * A failed copy is removed rather than left behind: a half-filled volume is
 * worse than no copy at all, because it looks like a backup.
 */
export async function cloneVolume(
  worker: typeof workers.$inferSelect,
  appId: string,
  sourceName: string,
  stampMs: number,
): Promise<string> {
  const target = volumeCopyName(appId, sourceName, stampMs);

  return withPodman(worker, async (client) => {
    await client.createVolume(target, {
      [MANAGED_LABEL]: 'true',
      [APP_ID_LABEL]: appId,
      // The exact source name, which the copy's own name cannot carry: the base
      // segment has been through `volumeBaseName`. `buildAppStorage` matches on
      // this to attach the copy to the volume it was really taken from.
      [COPY_SOURCE_LABEL]: sourceName,
    });

    try {
      await copyVolumeContents(client, appId, sourceName, target);
    } catch (e) {
      try {
        await client.removeVolume(target, true);
      } catch (cleanupError) {
        console.warn(`[volume-ops] Could not remove the failed copy ${target}:`, cleanupError);
      }
      throw e;
    }

    return target;
  });
}

/**
 * Put a copy back over the volume it was taken from.
 *
 * Always a replacement, never a merge: the target is recreated first. A copy is
 * taken to be able to return to a known state, and merging one over whatever is
 * there now produces a state that never existed — which is the opposite of the
 * reason it was taken.
 */
export async function restoreFromCopy(
  worker: typeof workers.$inferSelect,
  appId: string,
  copyName: string,
  targetName: string,
): Promise<void> {
  await withPodman(worker, async (client) => {
    // As in `restoreVolume`: established before the target is destroyed, not
    // when the helper is created halfway through.
    await client.ensureImage(env.VOLUME_TOOL_IMAGE);

    await client.removeVolume(targetName, true);
    await client.createVolume(targetName);
    await copyVolumeContents(client, appId, copyName, targetName);
  });
}
