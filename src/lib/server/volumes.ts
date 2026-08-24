/**
 * Names for the Podman volumes Rudder creates on a worker.
 *
 * There are three rules. Two of them name volumes an application *runs on*:
 * compose derives `rudder-<app8>-<service>-<name>` because a compose file scopes
 * volume names per service; the volume registry derives `rudder-<app8>-<name>`
 * because a registered volume belongs to the application, not to any container
 * in it.
 *
 * **Neither of those two may change.** A volume's name is the only thing tying a
 * running application to the data it wrote last week: rename it and Podman
 * creates a new empty volume, the application comes up looking freshly
 * installed, and the old data is still on the worker under a name nothing
 * refers to. Unifying the two would be tidier and would silently orphan every
 * volume already in service.
 *
 * The third rule names a *copy* — `rudder-copy-<app8>-<base>-<stamp>`, taken on
 * request as a safety net before a risky change. Nothing runs on one, so it is
 * free to change; it is here because this module is the only place a volume name
 * is composed.
 *
 * What this module does is be the only place any of the rules is written down.
 * New deployment formats adopt the compose rule.
 */
import type { MountIntent } from './mounts';

/** The application-scoped prefix both rules share. */
function prefixFor(appId: string | undefined | null): string {
  return appId ? `rudder-${appId.slice(0, 8)}-` : 'rudder-';
}

/**
 * Slug the part of a volume name that comes from the manifest.
 *
 * Compose sources are paths as often as they are names (`./data`, `~/cache`),
 * and Podman volume names are a restricted alphabet, so everything outside it
 * collapses to a dash.
 */
export function volumeBaseName(source: string, fallbackTarget: string): string {
  return (
    (source || fallbackTarget)
      .replace(/^[.~/]+/, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'vol'
  );
}

/**
 * `rudder-<app8>-<service>-<name>` — a volume belonging to one service of a
 * multi-container application. Two services that both declare `./data` get
 * their own, which is what compose semantics say should happen.
 */
export function composeVolumeName(
  appId: string | undefined | null,
  serviceName: string,
  baseName: string,
): string {
  return `${prefixFor(appId)}${serviceName}-${baseName}`;
}

/**
 * `rudder-<app8>-<name>` — a volume from the registry, which is scoped to the
 * application. Predates the compose rule and cannot adopt it: existing volumes
 * are named this way and hold data.
 */
export function registryVolumeName(appId: string, volumeName: string): string {
  return `${prefixFor(appId)}${volumeName}`;
}

/** The fixed prefix every copy carries, and nothing an application runs on can. */
const COPY_PREFIX = 'rudder-copy-';

/**
 * `rudder-copy-<app8>-<base>-<stamp>` — a point-in-time copy of another volume.
 *
 * The literal `copy` is what keeps the two namespaces apart, and provably so: an
 * application id is UUID hex, and `o`, `p` and `y` are not hex digits, so no
 * `rudder-<app8>-…` name can ever begin `rudder-copy-`. That is what lets the
 * scan for an application's volumes treat everything under `rudder-<app8>-` as
 * storage the application runs on, without a copy it took last week showing up
 * as a stray volume to be cleaned away.
 *
 * `stamp` is epoch milliseconds — sortable, and unique enough that two copies of
 * one volume cannot collide unless they were asked for in the same millisecond.
 */
export function volumeCopyName(appId: string, sourceName: string, stampMs: number): string {
  return `${COPY_PREFIX}${appId.slice(0, 8)}-${volumeCopyBase(appId, sourceName)}-${stampMs}`;
}

/**
 * The `base` segment a copy of `volumeName` carries.
 *
 * Exported because matching a copy back to its source is a *name* comparison,
 * and doing it by eye at the call site is how the two drift: a registry volume
 * called `my_vol` has a label of `my_vol` but a copy base of `my-vol`, because
 * `volumeBaseName` collapses everything outside Podman's safe alphabet. Both
 * sides go through this.
 */
export function volumeCopyBase(appId: string, volumeName: string): string {
  return volumeBaseName(stripAppPrefix(appId, volumeName), volumeName);
}

/**
 * Read a copy's name back, or null if it is not one.
 *
 * `base` is the source volume's name with its application prefix already
 * removed, which is what the copy was named from — not enough to rebuild the
 * source name, and not used for that. Copies are identified by their own name.
 */
export function parseVolumeCopyName(
  name: string,
): { appId8: string; base: string; at: number } | null {
  if (!name.startsWith(COPY_PREFIX)) return null;
  // Exactly eight hex digits, because `appId.slice(0, 8)` of a UUID is always
  // eight — a looser count would make `rudder-copy-abcdef12-abc-1` ambiguous
  // about where the id ends and the base begins. The base is matched lazily so
  // the trailing digits go to the stamp: greedily, a base of `db-data` and a
  // stamp of `1700000000000` parse as a base of `db-data-170000000000` and a
  // stamp of `0`.
  const match = /^([0-9a-f]{8})-(.+?)-(\d+)$/.exec(name.slice(COPY_PREFIX.length));
  if (!match) return null;
  return { appId8: match[1], base: match[2], at: Number(match[3]) };
}

/** True when this copy belongs to `appId`. */
export function isCopyOfApp(name: string, appId: string): boolean {
  return parseVolumeCopyName(name)?.appId8 === appId.slice(0, 8);
}

/**
 * A volume name with its application prefix taken off, for display and for
 * naming copies. Left alone when the name is not application-scoped — a bare
 * compose volume such as `pgdata` has no prefix to remove.
 */
export function stripAppPrefix(appId: string, volumeName: string): string {
  const prefix = prefixFor(appId);
  return volumeName.startsWith(prefix) ? volumeName.slice(prefix.length) : volumeName;
}

/** True when `name` is scoped to `appId` by either of the two running-volume rules. */
export function isAppScopedVolume(name: string, appId: string): boolean {
  return name.startsWith(prefixFor(appId));
}

/** One entry of a single-container application's `volumes` JSON column. */
export interface AppVolumeMount {
  hostPath?: string;
  containerPath?: string;
  mode?: string;
  volumeId?: string | null;
}

/**
 * Mount intents for a single-container application.
 *
 * `registry` supplies the volumes the application references by id, already
 * looked up — the function stays pure so it can be tested without a database.
 * A referenced volume that is not in the map has been deleted from the registry
 * since the application was configured; it is dropped rather than guessed at,
 * which is what this has always done.
 */
export function singleMountIntents(
  appId: string,
  raw: string | null | undefined,
  registry: ReadonlyMap<string, { name: string; containerPath: string }>,
): MountIntent[] {
  if (!raw) return [];

  let declared: AppVolumeMount[];
  try {
    declared = JSON.parse(raw);
  } catch {
    // Malformed JSON: nothing to mount. Same as before this was extracted.
    return [];
  }
  if (!Array.isArray(declared)) return [];

  const intents: MountIntent[] = [];
  for (const v of declared) {
    if (v.volumeId) {
      const registered = registry.get(v.volumeId);
      if (!registered) continue;
      intents.push({
        kind: 'volume',
        name: registryVolumeName(appId, registered.name),
        target: registered.containerPath,
        mode: v.mode || 'rw',
      });
      continue;
    }
    if (!v.hostPath || !v.containerPath) continue;
    intents.push({
      kind: 'bind',
      source: v.hostPath,
      target: v.containerPath,
      mode: v.mode || 'rw',
    });
  }
  return intents;
}

/**
 * True when a compose volume source names a volume rather than a host path.
 *
 * An absolute path is a bind mount — the user knows their worker's filesystem,
 * and the mount policy decides whether they may use it. Everything else,
 * including a relative or `~`-prefixed path, becomes a named volume: a bind to
 * `./data` would resolve against the *control plane's* working directory, which
 * is not where the container runs.
 */
export function isHostPathSource(source: string): boolean {
  return source.startsWith('/');
}
