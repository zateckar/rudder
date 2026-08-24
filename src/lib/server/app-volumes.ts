/**
 * What storage an application actually uses — whatever it was written as.
 *
 * The volume *registry* only ever reached single-container applications, which
 * made it look as though volumes were a single-container feature. They are not:
 * a compose file's `./data` becomes a real Podman volume named by
 * `composeVolumeName`, created on first use and holding data across redeploys,
 * with no row anywhere describing it. Rudder created that storage, named it, and
 * then had no way to show it, measure it, copy it or delete it.
 *
 * The fix is deliberately not a fourth manifest parser. `desiredState` already
 * turns any of the three formats into `PlannedContainer[]` carrying
 * `MountIntent[]`, needs no port allocator, and *is* the computation a deploy
 * performs — so the volumes an application uses are read out of the same
 * intent the deploy acts on. A separate reader would eventually disagree with
 * the deploy, and the disagreement would surface as a delete button pointed at
 * the wrong volume.
 *
 * Split into a pure builder and a thin I/O wrapper: the interesting rules —
 * which names are app-scoped, which are shared with other applications, which
 * volumes on the worker nothing declares any more — are then testable against a
 * fixture without a worker.
 */
import { db } from '$lib/db';
import { applications, containers, teams, volumes, workers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { AuthorizationError } from './auth';
import type { MountIntent } from './mounts';
import type { PodmanVolume } from './podman';
import { withPodman } from './podman-client';
import { desiredState, type DesiredApp } from './reconcile';
import { ManifestError } from './deploy/plan';
import {
  isAppScopedVolume,
  parseVolumeCopyName,
  registryVolumeName,
  stripAppPrefix,
  volumeCopyBase,
} from './volumes';

/**
 * Where a volume's name came from, which decides what may safely be done to it.
 *
 * `shared` is the one that matters. A compose file saying `pgdata:/data` gets a
 * Podman volume literally called `pgdata` — see `parseCompose`, which passes a
 * non-relative source through unchanged — so it is *not* namespaced to the
 * application and may well be another application's data as well. Deleting one
 * is not a local decision.
 */
export type VolumeOrigin = 'registry' | 'app-scoped' | 'shared';

/** A copy taken of a volume, on request, as a safety net. */
export interface VolumeCopy {
  name: string;
  /** Epoch milliseconds, from the copy's own name. */
  at: number;
  sizeBytes: number | null;
}

export interface AppVolume {
  /** The Podman volume name — what `podman volume ls` shows. */
  name: string;
  /** The same name without its application prefix, for display. */
  label: string;
  origin: VolumeOrigin;
  /** The application's manifest asks for this volume as it stands now. */
  declared: boolean;
  /** It exists on the worker. False for a volume declared but never deployed. */
  present: boolean;
  /** Null when the worker could not be asked, not when the volume is empty. */
  sizeBytes: number | null;
  mountpoint: string | null;
  /** Which of the application's containers mount it, and where. */
  targets: { container: string; path: string; mode: string }[];
  /** `volumes.id`, when a registry row is what put this here. */
  registryId: string | null;
  /** `volumes.sizeLimit` — an intention recorded in the registry, not a quota Podman enforces. */
  sizeLimit: number | null;
  copies: VolumeCopy[];
}

/**
 * Storage that is not a named volume, listed so the view does not imply an
 * application has none. A host bind and a tmpfs cannot be sized, copied or
 * deleted as volumes — they are somebody else's directory and a piece of
 * memory — so they are reported and nothing more.
 */
export interface OtherMount {
  kind: 'bind' | 'tmpfs';
  /** The host path, for a bind. Null for a tmpfs, which has no source. */
  source: string | null;
  target: string;
  container: string;
}

export interface AppStorage {
  volumes: AppVolume[];
  otherMounts: OtherMount[];
  /** Why the worker could not be asked, when it could not. Sizes are null throughout. */
  unreachable: string | null;
  /**
   * The manifest no longer parses. The declared list is empty, but anything
   * found on the worker is still reported — an application whose manifest broke
   * is exactly one whose leftover data someone needs to reach.
   */
  manifestError: string | null;
}

/** A registry row as this module needs it: the Podman name it produces, plus its own id. */
interface RegistryEntry {
  id: string;
  podmanName: string;
  sizeLimit: number | null;
}

export interface WorkerVolumeSnapshot {
  volumes: PodmanVolume[];
  /** Volume name → bytes, from one `system/df`. */
  usage: Map<string, number>;
}

export interface BuildAppStorageInput {
  appId: string;
  /** Null when the manifest could not be read; `manifestError` says why. */
  desired: DesiredApp | null;
  manifestError: string | null;
  registry: RegistryEntry[];
  /** Null when the worker could not be asked. */
  snapshot: WorkerVolumeSnapshot | null;
  unreachable: string | null;
}

/**
 * Fold declared intent and the worker's actual volume list into one view.
 *
 * Pure. Everything that needs a database or a worker happens in `appStorage`.
 */
export function buildAppStorage(input: BuildAppStorageInput): AppStorage {
  const { appId, desired, snapshot } = input;
  const registryByName = new Map(input.registry.map((r) => [r.podmanName, r]));

  const byName = new Map<string, AppVolume>();
  const otherMounts: OtherMount[] = [];

  const originOf = (name: string): VolumeOrigin => {
    if (registryByName.has(name)) return 'registry';
    return isAppScopedVolume(name, appId) ? 'app-scoped' : 'shared';
  };

  const ensure = (name: string, declared: boolean): AppVolume => {
    let existing = byName.get(name);
    if (!existing) {
      const registered = registryByName.get(name) ?? null;
      existing = {
        name,
        label: stripAppPrefix(appId, name),
        origin: originOf(name),
        declared,
        present: false,
        sizeBytes: null,
        mountpoint: null,
        targets: [],
        registryId: registered?.id ?? null,
        sizeLimit: registered?.sizeLimit ?? null,
        copies: [],
      };
      byName.set(name, existing);
    }
    // Declared wins: a volume reached from both the manifest and the worker is
    // declared, whichever pass saw it first.
    if (declared) existing.declared = true;
    return existing;
  };

  // ── Declared ───────────────────────────────────────────────────────────────
  for (const container of desired?.containers ?? []) {
    for (const mount of container.planned.mounts as MountIntent[]) {
      switch (mount.kind) {
        case 'volume':
          ensure(mount.name, true).targets.push({
            container: container.key,
            path: mount.target,
            mode: mount.mode,
          });
          break;
        case 'bind':
          otherMounts.push({
            kind: 'bind',
            source: mount.source,
            target: mount.target,
            container: container.key,
          });
          break;
        case 'tmpfs':
          otherMounts.push({
            kind: 'tmpfs',
            source: null,
            target: mount.target,
            container: container.key,
          });
          break;
      }
    }
  }

  // ── Observed ───────────────────────────────────────────────────────────────
  //
  // Copies are matched first and attached to their source rather than listed as
  // volumes of their own, so a safety copy taken last week never reads as a
  // stray volume to be cleaned away. `rudder-copy-` cannot collide with
  // `rudder-<app8>-`; see `volumeCopyName`.
  const copiesBySource = new Map<string, VolumeCopy[]>();
  if (snapshot) {
    for (const found of snapshot.volumes) {
      const copy = parseVolumeCopyName(found.name);
      if (copy) {
        if (copy.appId8 !== appId.slice(0, 8)) continue;
        const list = copiesBySource.get(copy.base) ?? [];
        list.push({ name: found.name, at: copy.at, sizeBytes: snapshot.usage.get(found.name) ?? 0 });
        copiesBySource.set(copy.base, list);
        continue;
      }

      // Anything else app-scoped that nothing declares is a leftover from a
      // manifest edit: still holding data, still costing disk, and previously
      // unreachable from anywhere in the UI.
      if (!byName.has(found.name) && !isAppScopedVolume(found.name, appId)) continue;

      const volume = ensure(found.name, false);
      volume.present = true;
      volume.mountpoint = found.mountpoint;
      volume.sizeBytes = snapshot.usage.get(found.name) ?? 0;
    }

    for (const volume of byName.values()) {
      // Keyed on the copy base rather than the label: the two differ whenever a
      // volume name contains a character `volumeBaseName` collapses.
      volume.copies = (copiesBySource.get(volumeCopyBase(appId, volume.name)) ?? []).sort(
        (a, b) => b.at - a.at,
      );
    }
  }

  return {
    // Declared first, then leftovers; alphabetical within each so the list does
    // not reorder itself between reloads.
    volumes: [...byName.values()].sort(
      (a, b) => Number(b.declared) - Number(a.declared) || a.name.localeCompare(b.name),
    ),
    otherMounts,
    unreachable: input.unreachable,
    manifestError: input.manifestError,
  };
}

/**
 * The registry rows an application references, resolved to the Podman names they
 * produce.
 *
 * Mirrors `resolveVolumeRegistry` in `deploy.ts`, which reads the same column
 * for the same purpose but returns only what `singleMountIntents` needs. This
 * one keeps the row id and size limit as well, so a registry-backed volume can
 * be traced back to the entry that declared it.
 */
async function referencedRegistry(
  appId: string,
  raw: string | null | undefined,
): Promise<{ entries: RegistryEntry[]; forDesiredState: Map<string, { name: string; containerPath: string }> }> {
  const empty = { entries: [], forDesiredState: new Map() };
  if (!raw) return empty;

  let referenced: string[] = [];
  try {
    const declared = JSON.parse(raw);
    if (Array.isArray(declared)) {
      referenced = declared
        .map((v: { volumeId?: string }) => v?.volumeId)
        .filter((id): id is string => !!id);
    }
  } catch {
    // Malformed JSON: nothing to look up. `singleMountIntents` reads it the
    // same way, so the two agree on an application with an unusable column.
    return empty;
  }
  if (referenced.length === 0) return empty;

  const rows = await db.select().from(volumes).where(inArray(volumes.id, referenced)).all();
  return {
    entries: rows.map((row) => ({
      id: row.id,
      podmanName: registryVolumeName(appId, row.name),
      sizeLimit: row.sizeLimit,
    })),
    forDesiredState: new Map(
      rows.map((row) => [row.id, { name: row.name, containerPath: row.containerPath }]),
    ),
  };
}

/**
 * Every volume this application uses, with its real size on the worker.
 *
 * One Podman round trip: `listVolumes` for what exists and `system/df` for how
 * big it is. A worker that is offline, or has no Podman URL, leaves `unreachable`
 * set and every size null — the declared list still renders, which is the view
 * someone reaching for this page during an outage needs.
 */
export async function appStorage(
  app: typeof applications.$inferSelect,
  worker: typeof workers.$inferSelect | null,
): Promise<AppStorage> {
  const registry = await referencedRegistry(app.id, app.volumes);

  const team = app.teamId
    ? await db.select().from(teams).where(eq(teams.id, app.teamId)).get()
    : null;

  let desired: DesiredApp | null = null;
  let manifestError: string | null = null;
  if (worker) {
    try {
      desired = desiredState({
        app,
        worker,
        team: team ?? null,
        volumeRegistry: registry.forDesiredState,
      });
    } catch (e: unknown) {
      // A manifest that stopped parsing must not hide the data it left behind.
      manifestError =
        e instanceof ManifestError || e instanceof Error ? e.message : String(e);
    }
  }

  if (!worker) {
    return buildAppStorage({
      appId: app.id,
      desired: null,
      manifestError,
      registry: registry.entries,
      snapshot: null,
      unreachable: 'This application is not assigned to a worker, so it has no storage yet.',
    });
  }

  let snapshot: WorkerVolumeSnapshot | null = null;
  let unreachable: string | null = null;
  try {
    snapshot = await withPodman(worker, async (client) => ({
      volumes: await client.listVolumes(),
      usage: await client.volumeUsage(),
    }));
  } catch (e: unknown) {
    unreachable =
      `Worker "${worker.name}" could not be reached, so sizes and any volumes left behind by a ` +
      `previous configuration are not shown: ${e instanceof Error ? e.message : String(e)}`;
  }

  return buildAppStorage({
    appId: app.id,
    desired,
    manifestError,
    registry: registry.entries,
    snapshot,
    unreachable,
  });
}

/**
 * Resolve a volume the caller may act on, with the worker it lives on.
 *
 * The reason every mutating route goes through this: `[name]` arrives from the
 * URL, and a route that took it at face value would be a free hand on any volume
 * on the worker — including another team's, on a shared worker. A name this
 * application does not use is reported as absent, following the 404 rule the
 * rest of the authorization layer keeps.
 *
 * `copyOf` is set when `name` is one of the application's copies rather than a
 * volume it runs on. Copies are addressable — they can be restored from and
 * deleted — but they are not in `storage.volumes`, so a lookup by name alone
 * would not find them.
 */
export async function requireAppVolume(
  app: typeof applications.$inferSelect,
  volumeName: string,
): Promise<{
  worker: typeof workers.$inferSelect;
  storage: AppStorage;
  volume: AppVolume;
  copyOf: AppVolume | null;
}> {
  if (!app.workerId) {
    throw new AuthorizationError('This application is not assigned to a worker.', 409);
  }
  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) throw new AuthorizationError('Worker not found', 404);

  const storage = await appStorage(app, worker);
  if (storage.unreachable) {
    // Every operation below needs the worker. Refusing with its own words beats
    // a Podman error from three calls deeper.
    throw new AuthorizationError(storage.unreachable, 502);
  }

  const direct = storage.volumes.find((v) => v.name === volumeName);
  if (direct) return { worker, storage, volume: direct, copyOf: null };

  const owner = storage.volumes.find((v) => v.copies.some((c) => c.name === volumeName));
  if (owner) {
    const copy = owner.copies.find((c) => c.name === volumeName)!;
    return {
      worker,
      storage,
      volume: {
        ...owner,
        name: copy.name,
        label: `${owner.label} (copy)`,
        declared: false,
        present: true,
        sizeBytes: copy.sizeBytes,
        targets: [],
        registryId: null,
        copies: [],
      },
      copyOf: owner,
    };
  }

  throw new AuthorizationError(`"${volumeName}" is not a volume this application uses.`, 404);
}

/**
 * The application's containers that are running, by name.
 *
 * Restoring a volume overwrites files under whatever has them open. On a
 * database that is how a restore produces a corrupt store rather than the state
 * that was backed up, so it is refused while anything is running — and the
 * refusal names what to stop.
 */
export async function runningContainerNames(appId: string): Promise<string[]> {
  const rows = await db
    .select({ name: containers.name, status: containers.status })
    .from(containers)
    .where(eq(containers.applicationId, appId))
    .all();
  return rows.filter((r) => r.status === 'running').map((r) => r.name);
}

/**
 * The applications *other than* `appId` on the same worker that declare
 * `volumeName`.
 *
 * Asked before deleting a volume whose name is not namespaced — a bare compose
 * `pgdata:/data` produces a volume shared by every application that names it, so
 * "delete this application's volume" can mean deleting another team's database.
 * Computed rather than guessed at, using the same per-worker `desiredState` loop
 * `reconcileWorker` runs; the set of applications on one worker is small.
 */
export async function otherAppsUsing(
  volumeName: string,
  appId: string,
  worker: typeof workers.$inferSelect,
): Promise<string[]> {
  const workerApps = await db
    .select()
    .from(applications)
    .where(eq(applications.workerId, worker.id))
    .all();

  const teamRows = await db.select().from(teams).all();
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const volumeRows = await db.select().from(volumes).all();
  const volumeById = new Map(
    volumeRows.map((v) => [v.id, { name: v.name, containerPath: v.containerPath }]),
  );

  const users: string[] = [];
  for (const other of workerApps) {
    if (other.id === appId) continue;
    try {
      const state = desiredState({
        app: other,
        worker,
        team: other.teamId ? teamById.get(other.teamId) : null,
        volumeRegistry: volumeById,
      });
      const uses = state.containers.some((c) =>
        c.planned.mounts.some((m) => m.kind === 'volume' && m.name === volumeName),
      );
      if (uses) users.push(other.name);
    } catch {
      // An application whose manifest does not parse cannot be shown to use
      // this volume, and must not block deleting it either.
    }
  }
  return users;
}
