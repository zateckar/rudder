/**
 * Names for the Podman volumes Rudder creates on a worker.
 *
 * There are two rules, and there will go on being two. Compose derives
 * `rudder-<app8>-<service>-<name>` because a compose file scopes volume names
 * per service; the volume registry derives `rudder-<app8>-<name>` because a
 * registered volume belongs to the application, not to any container in it.
 *
 * **Neither rule may change.** A volume's name is the only thing tying a
 * running application to the data it wrote last week: rename it and Podman
 * creates a new empty volume, the application comes up looking freshly
 * installed, and the old data is still on the worker under a name nothing
 * refers to. Unifying the two would be tidier and would silently orphan every
 * volume already in service.
 *
 * What this module does instead is be the only place either rule is written
 * down. New deployment formats adopt the compose rule.
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
