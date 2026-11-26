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
import type { workers } from '#lib/db/schema.ts';
import { env } from './env';
import { realizeMounts, type MountIntent } from './mounts';
import { PodmanApiError, type PodmanClient } from './podman';
import { getRestPodmanClient, withPodman } from './podman-client';
// The labels come from `reconcile`, which is what reads them back: a helper is
// labelled so `mayRemove` permits cleaning one up and so `isTransientHelper` can
// keep a mid-operation helper out of the drift report.
import { APP_ID_LABEL, HELPER_ROLE, MANAGED_LABEL, ROLE_LABEL } from './reconcile';
import { COPY_SOURCE_LABEL, volumeCopyName } from './volumes';
import { requireTarEnd } from './tar';

/** Where a helper sees the volume it is working on. */
const MOUNT_AT = '/volume';
/** Clone source and destination, kept apart so `cp -a` cannot recurse into itself. */
const CLONE_FROM = '/from';
const CLONE_TO = '/to';
const STAGED_ARCHIVE = '/restore';

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

export class VolumeRestoreError extends Error {
  constructor(message: string, readonly recoveryVolume?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Replace from a staged archive or explicitly merge the archive into the live volume. */
export async function restoreVolume(
  worker: typeof workers.$inferSelect,
  appId: string,
  volumeName: string,
  archive: ReadableStream<Uint8Array>,
  mode: RestoreMode,
  beforeInstall?: () => Promise<void>,
): Promise<void> {
  await withPodman(worker, async (client) => {
    if (mode === 'replace') {
      return replaceVolume(client, appId, volumeName, async (stage) => {
        // A Rudder backup has one root, volume/. Extract it inside the staging
        // mount so the helper can verify that root before touching the target.
        await withVolumeHelper(
          client,
          appId,
          [{ kind: 'volume', name: stage, target: STAGED_ARCHIVE, mode: 'rw' }],
          IDLE_CMD,
          (id) => client.putArchiveStream(id, STAGED_ARCHIVE, requireTarEnd(archive)),
        );
        await withVolumeHelper(
          client,
          appId,
          [{ kind: 'volume', name: stage, target: CLONE_FROM, mode: 'ro' }],
          ['sh', '-ec', `test -d ${CLONE_FROM}${MOUNT_AT} && test ! -L ${CLONE_FROM}${MOUNT_AT}`],
          async (id) => {
            if (await client.waitContainer(id) !== 0) {
              throw new Error('The archive does not contain the volume/ directory produced by Rudder Backup.');
            }
          },
        );
      }, beforeInstall, `${CLONE_FROM}${MOUNT_AT}`);
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
 * Replacement clears only the directory mounted at /to. The original Podman
 * volume and its configuration stay in place, along with stopped consumers.
 */
async function copyVolumeContents(
  client: PodmanClient,
  appId: string,
  from: string,
  to: string,
  { replace = false, source = CLONE_FROM }: { replace?: boolean; source?: string } = {},
): Promise<void> {
  const clearTarget = replace
    ? `for entry in ${CLONE_TO}/* ${CLONE_TO}/.[!.]* ${CLONE_TO}/..?*; do rm -rf -- "$entry"; done; `
    : '';
  await withVolumeHelper(
    client,
    appId,
    [
      { kind: 'volume', name: from, target: CLONE_FROM, mode: 'ro' },
      { kind: 'volume', name: to, target: CLONE_TO, mode: 'rw' },
    ],
    // `/from/.` rather than `/from`: copying the directory itself would produce
    // `/to/from/…`.
    ['sh', '-ec', `${clearTarget}cp -a ${source}/. ${CLONE_TO}/; sync`],
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
  return withPodman(worker, (client) => createVolumeCopy(client, appId, sourceName, stampMs));
}

async function discardVolume(client: PodmanClient, name: string): Promise<void> {
  try {
    await client.removeVolume(name);
  } catch (error) {
    console.warn(`[volume-ops] Could not remove temporary volume "${name}":`, error);
  }
}

async function createVolumeCopy(
  client: PodmanClient,
  appId: string,
  source: string,
  stampMs: number,
): Promise<string> {
  await client.inspectVolume(source);
  // The worker lock serializes Rudder's copies, but two operations can use the
  // same timestamp. Never overlay or clean up an existing copy at that name.
  let target = volumeCopyName(appId, source, stampMs);
  while (await volumeExists(client, target)) {
    stampMs += 1;
    target = volumeCopyName(appId, source, stampMs);
  }
  await client.createVolume(target, {
    [MANAGED_LABEL]: 'true',
    [APP_ID_LABEL]: appId,
    [COPY_SOURCE_LABEL]: source,
  });
  try {
    await copyVolumeContents(client, appId, source, target);
  } catch (error) {
    await discardVolume(client, target);
    throw error;
  }
  return target;
}

async function volumeExists(client: PodmanClient, name: string): Promise<boolean> {
  try {
    await client.inspectVolume(name);
    return true;
  } catch (error) {
    if (PodmanApiError.hasStatus(error, 404)) return false;
    throw error;
  }
}

/**
 * Finish staging and snapshotting before any write to the destination. Keep the
 * snapshot available if restoring the original after a failed promotion also fails.
 */
async function replaceVolume(
  client: PodmanClient,
  appId: string,
  target: string,
  stageContents: (name: string) => Promise<void>,
  beforeInstall?: () => Promise<void>,
  source?: string,
): Promise<void> {
  const stage = `rudder-${appId.slice(0, 8)}-restore-stage-${crypto.randomUUID()}`;
  let recovery: string | undefined;
  let keepRecovery = false;
  try {
    try {
      await client.createVolume(stage, { [MANAGED_LABEL]: 'true', [APP_ID_LABEL]: appId });
      await stageContents(stage);
      if (await volumeExists(client, target)) {
        recovery = await createVolumeCopy(client, appId, target, Date.now());
      }
    } catch (error) {
      throw new VolumeRestoreError(
        `Could not prepare the replacement for "${target}". Existing contents were preserved. ${errorMessage(error)}`,
        undefined,
        { cause: error },
      );
    }

    // A long archive upload or copy may overlap with a start outside Rudder.
    // Recheck the destination immediately before any write to it.
    await beforeInstall?.();
    try {
      if (!recovery) await client.createVolume(target);
      await copyVolumeContents(client, appId, stage, target, { replace: true, source });
    } catch (error) {
      if (!recovery) {
        await discardVolume(client, target);
        throw new VolumeRestoreError(`Could not install the replacement into "${target}". ${errorMessage(error)}`, undefined, { cause: error });
      }
      try {
        await copyVolumeContents(client, appId, recovery, target, { replace: true });
      } catch (restoreError) {
        keepRecovery = true;
        throw new VolumeRestoreError(
          `Replacing "${target}" failed and its original contents could not be put back. Keep the application stopped. The original data is saved in "${recovery}". ${errorMessage(restoreError)}`,
          recovery,
          { cause: error },
        );
      }
      throw new VolumeRestoreError(
        `Could not install the replacement into "${target}". The original contents were restored. ${errorMessage(error)}`,
        undefined,
        { cause: error },
      );
    }
  } finally {
    await discardVolume(client, stage);
    if (recovery && !keepRecovery) await discardVolume(client, recovery);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Install a verified copy over the volume it was taken from. */
export async function restoreFromCopy(
  worker: typeof workers.$inferSelect,
  appId: string,
  copyName: string,
  targetName: string,
  beforeInstall?: () => Promise<void>,
): Promise<void> {
  await withPodman(worker, async (client) => {
    await replaceVolume(client, appId, targetName, async (stage) => {
      await client.inspectVolume(copyName);
      await copyVolumeContents(client, appId, copyName, stage);
    }, beforeInstall);
  });
}
