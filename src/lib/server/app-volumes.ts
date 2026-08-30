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
import { desiredState, podmanName, type DesiredApp } from './reconcile';
import { ManifestError } from './deploy/plan';
import {
  COPY_SOURCE_LABEL,
  isAppScopedVolume,
  parseVolumeCopyName,
  registryVolumeName,
  stripAppPrefix,
  volumeCopyBase,
  volumeOwnerApp8,
} from './volumes';

/**
 * Where a volume's name came from, which decides what may safely be done to it.
 *
 * `registry` and `app-scoped` names are derived from this application's id, so
 * nothing else can be behind one and every operation is this application's own
 * business.
 *
 * The other two are both cases of a manifest naming a volume outright — see
 * `parseCompose`, which passes a non-relative source through unchanged — and they
 * differ in whether the name says who owns it:
 *
 * - `foreign` — the name is one Rudder composed for a *different* application:
 *   `rudder-<other8>-…` or `rudder-copy-<other8>-…`. Refused outright; see
 *   `assertNotSharedWithOthers`.
 * - `shared` — a name Rudder did not compose, such as `pgdata`. It is not
 *   namespaced to anything, so it may well be another application's data as
 *   well, and deleting one is not a local decision. Whether anyone else declares
 *   it is the most that can be asked.
 */
export type VolumeOrigin = 'registry' | 'app-scoped' | 'shared' | 'foreign';

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
  /**
   * Volume name → bytes, from one `system/df`. Null when sizes were not asked
   * for, which leaves every `sizeBytes` null rather than zero — see
   * `appStorage`'s `sizes` option for why a caller would decline them.
   */
  usage: Map<string, number> | null;
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
    if (isAppScopedVolume(name, appId)) return 'app-scoped';
    // A name Rudder composed for another application. Checked before `shared`
    // because the two are asked different questions: a name carrying somebody
    // else's id is answered by the name alone, and no lookup can overrule it.
    const owner = volumeOwnerApp8(name);
    return owner && owner !== appId.slice(0, 8) ? 'foreign' : 'shared';
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
  //
  // Matched on `COPY_SOURCE_LABEL`, which holds the source's exact name.
  // `volumeCopyBase` is lossy — `web_1-data` and `web-1-data` share a base — so
  // keying on it attaches each of two such volumes' copies to both, and
  // `requireAppVolume` then resolves the copy's `copyOf` to whichever sorts
  // first: a restore that force-removes and overwrites the wrong volume. The
  // base is still consulted, but only for copies taken before the label existed.
  const copiesBySource = new Map<string, VolumeCopy[]>();
  const copiesByBase = new Map<string, VolumeCopy[]>();
  if (snapshot) {
    for (const found of snapshot.volumes) {
      const copy = parseVolumeCopyName(found.name);
      if (copy) {
        if (copy.appId8 !== appId.slice(0, 8)) continue;
        const entry = {
          name: found.name,
          at: copy.at,
          sizeBytes: snapshot.usage ? (snapshot.usage.get(found.name) ?? 0) : null,
        };
        const source = found.labels?.[COPY_SOURCE_LABEL];
        const index = source ? copiesBySource : copiesByBase;
        const key = source || copy.base;
        index.set(key, [...(index.get(key) ?? []), entry]);
        continue;
      }

      // Anything else app-scoped that nothing declares is a leftover from a
      // manifest edit: still holding data, still costing disk, and previously
      // unreachable from anywhere in the UI.
      if (!byName.has(found.name) && !isAppScopedVolume(found.name, appId)) continue;

      const volume = ensure(found.name, false);
      volume.present = true;
      if (volume.origin === 'foreign') {
        // It exists — worth saying, since the manifest mounts it — but its size
        // and mount point are facts about another application's data, and the
        // inspect route refuses to report them for the same reason. Nothing can
        // be done to it from here either way; see `assertNotAnotherApps`.
        continue;
      }
      volume.mountpoint = found.mountpoint;
      volume.sizeBytes = snapshot.usage ? (snapshot.usage.get(found.name) ?? 0) : null;
    }

    for (const volume of byName.values()) {
      volume.copies = [
        ...(copiesBySource.get(volume.name) ?? []),
        ...(copiesByBase.get(volumeCopyBase(appId, volume.name)) ?? []),
      ].sort((a, b) => b.at - a.at);
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
 * The registry volume ids an application's `volumes` column references.
 *
 * Malformed JSON yields none, which is how `singleMountIntents` reads the same
 * column — so the two agree on an application with an unusable one.
 */
function referencedVolumeIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const declared = JSON.parse(raw);
    if (!Array.isArray(declared)) return [];
    return declared
      .map((v: { volumeId?: string }) => v?.volumeId)
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
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
  const referenced = referencedVolumeIds(raw);
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
 * Every volume this application uses, and — when asked — its real size on disk.
 *
 * `listVolumes` for what exists, and `system/df` for how big it is. A worker that
 * is offline, or has no Podman URL, leaves `unreachable` set and every size null;
 * the declared list still renders, which is the view someone reaching for this
 * page during an outage needs.
 *
 * `sizes` defaults to false because `system/df` is the expensive half by a wide
 * margin — it is the only place Podman reports volume usage and it computes it by
 * walking the storage tree — and the callers that resolve a volume in order to
 * *act* on it never read a size. Only the listing endpoint pays for it. When it
 * is wanted, the two calls go out together rather than one after the other.
 */
export async function appStorage(
  app: typeof applications.$inferSelect,
  worker: typeof workers.$inferSelect | null,
  { sizes = false }: { sizes?: boolean } = {},
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
    snapshot = await withPodman(worker, async (client) => {
      const [volumes, usage] = await Promise.all([
        client.listVolumes(),
        sizes ? client.volumeUsage() : Promise.resolve(null),
      ]);
      return { volumes, usage };
    });
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
 *
 * `action` says what the caller is about to do, and is what makes resolving a
 * volume safe rather than merely scoped. Being *declared* is not ownership: a
 * manifest is authored by an ordinary team member and `parseCompose` passes a
 * non-relative source through verbatim, so `pgdata:/data` — or
 * `rudder-<someone-else8>-pgdata:/data` — declares a volume this application has
 * no claim to. Every operation that reads or writes contents therefore names
 * itself and is refused on a volume that is not this application's alone; see
 * `assertNotSharedWithOthers`. `null` is for a read that touches no contents —
 * the inspect GET — and is the only way to opt out.
 *
 * `sizes` is off by default: resolving a volume in order to act on it needs to
 * know that it exists, not how big it is, and asking costs a `system/df` sweep of
 * the worker's storage. See `appStorage`.
 */
export async function requireAppVolume(
  app: typeof applications.$inferSelect,
  volumeName: string,
  action: SharedVolumeAction | null,
  { sizes = false }: { sizes?: boolean } = {},
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

  const storage = await appStorage(app, worker, { sizes });
  if (storage.unreachable) {
    // Every operation below needs the worker. Refusing with its own words beats
    // a Podman error from three calls deeper.
    throw new AuthorizationError(storage.unreachable, 502);
  }

  const direct = storage.volumes.find((v) => v.name === volumeName);
  if (direct) {
    // Ownership is not a function of what the caller intends, so this one runs
    // even for the inspect read that opts out of everything else.
    assertNotAnotherApps(direct, action);
    if (action) await assertNotSharedWithOthers(app, worker, direct, action);
    return { worker, storage, volume: direct, copyOf: null };
  }

  // A copy needs no such check: `rudder-copy-<app8>-…` is generated here and
  // provably namespaced to this application, so no other application's data can
  // be behind one. The volume a copy is *written back onto* is another matter —
  // that is `copyOf`, and the copy route checks it explicitly.
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
 * The application's containers that are running, by name, according to the
 * database.
 *
 * Restoring a volume overwrites files under whatever has them open. On a
 * database that is how a restore produces a corrupt store rather than the state
 * that was backed up, so it is refused while anything is running — and the
 * refusal names what to stop.
 *
 * `containers.status` is written by the fleet sweep, so it is up to one
 * collection interval old — which the operator can set as high as an hour.
 * That is fine for the *advisory* uses of this (showing the operator what they
 * will have to stop) and not fine for the guard in front of a restore, which
 * gets `runningContainerNamesLive` instead.
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
 * The same question, asked of the worker rather than of the database.
 *
 * The guard in front of a volume restore cannot be answered from
 * `containers.status`: that column is a snapshot from the last fleet sweep, so
 * a container started thirty seconds ago — by an operator, by a restart policy
 * after a crash, by anything that is not a Rudder deploy — still reads
 * `exited`. The restore then went ahead and extracted an archive over files a
 * live database had open, which is the exact corruption the guard exists to
 * prevent, and the audit trail recorded that the check had passed.
 *
 * Fails closed. If the worker cannot be reached, this throws rather than
 * returning an empty list: "I could not ask" and "nothing is running" must not
 * produce the same answer in front of a destructive, unrecoverable operation.
 */
export async function runningContainerNamesLive(
  worker: typeof workers.$inferSelect,
  appId: string,
): Promise<string[]> {
  const rows = await db
    .select({ containerId: containers.containerId, name: containers.name })
    .from(containers)
    .where(eq(containers.applicationId, appId))
    .all();
  if (rows.length === 0) return [];

  const live = await withPodman(worker, (client) => client.listContainers(true));
  const runningIds = new Set<string>();
  const runningNames = new Set<string>();
  for (const c of live) {
    if (c.State !== 'running') continue;
    runningIds.add(c.Id);
    runningNames.add(podmanName(c.Names?.[0]));
  }

  // Matched on either, because the two can disagree: a row whose container was
  // recreated out of band holds a stale id under a name that is still this
  // application's, and a name match is enough to refuse.
  return rows
    .filter((r) => runningIds.has(r.containerId) || runningNames.has(podmanName(r.name)))
    .map((r) => r.name);
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

  // Both lookups are scoped to what this worker's applications actually
  // reference. They used to load the `teams` and `volumes` tables whole, on every
  // shared-volume assertion — which is once per destructive operation, to answer
  // a question about a handful of rows.
  const teamIds = [...new Set(workerApps.map((a) => a.teamId).filter((id): id is string => !!id))];
  const volumeIds = [...new Set(workerApps.flatMap((a) => referencedVolumeIds(a.volumes)))];

  const teamRows = teamIds.length
    ? await db.select().from(teams).where(inArray(teams.id, teamIds)).all()
    : [];
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const volumeRows = volumeIds.length
    ? await db.select().from(volumes).where(inArray(volumes.id, volumeIds)).all()
    : [];
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

/** What a caller is about to do to a volume's contents, for the refusals below. */
export type SharedVolumeAction = 'delete' | 'restore' | 'back up' | 'copy';

/**
 * Refuse a volume whose name Rudder generated for a different application.
 *
 * Synchronous and unconditional, which is the point: this asks nothing of the
 * database and nothing of the caller's intent, so unlike the shared-volume check
 * it also covers the inspect read — which would otherwise report a neighbour's
 * volume's size and mount point — and cannot be weakened by the neighbour's
 * manifest happening not to parse.
 */
function assertNotAnotherApps(volume: AppVolume, action: SharedVolumeAction | null): void {
  if (volume.origin !== 'foreign') return;

  throw new AuthorizationError(
    `"${volume.name}" belongs to another application: Rudder generated that name for ` +
      `application ${volumeOwnerApp8(volume.name)}, not this one. ` +
      `${action ? `${SHARED_CONSEQUENCE[action]}. ` : ''}` +
      `Declaring another application's volume in a manifest does not transfer it — mount a ` +
      `volume of your own instead.`,
    409,
  );
}

/** What each of them would do to the other application, in its own words. */
const SHARED_CONSEQUENCE: Record<SharedVolumeAction, string> = {
  delete: 'Deleting it would delete their data too',
  restore:
    'Restoring over it would overwrite their data — under containers of theirs that may be ' +
    'running, which is how a restore corrupts a database rather than restoring one',
  'back up': 'Backing it up would hand you their data',
  copy: 'Copying it would take a copy of their data',
};

/**
 * Refuse an operation on a volume that is not this application's alone.
 *
 * A volume reaches an application's storage list because its manifest declares
 * it, and a declaration is not a claim: a bare compose source is passed through
 * as written, so `pgdata:/data` names whatever `pgdata` already is on that
 * worker, and a source spelled `rudder-<someone-else8>-db-data` names another
 * team's volume outright. `app-scoped` and `registry` names are derived from
 * *this* application's id and cannot say that, so they are let straight through.
 *
 * The other two are refused on different grounds, and the difference is the whole
 * of this function:
 *
 * **`foreign` — the name itself says whose it is.** Every rule in `volumes.ts`
 * embeds `appId.slice(0, 8)`, so a volume Rudder created carries its owner in its
 * name; `volumeOwnerApp8` reads it back. Refused outright, with no lookup,
 * because no lookup could overrule it. This is what the "does anyone else declare
 * it" test below cannot catch: a neighbour's leftover volume from an earlier
 * manifest, a neighbour's safety copy (nothing ever declares a copy), and
 * everything a neighbour owns during the ordinary minutes when its manifest does
 * not parse all answer "nobody declares this" while being unambiguously somebody
 * else's data.
 *
 * **`shared` — the name proves nothing, so the worker is asked.** Does another
 * application declare this volume? Computed with the same per-worker
 * `desiredState` loop `reconcileWorker` runs. If one does, every operation that
 * reads or writes the contents is refused — reads included, because a backup or a
 * copy of another team's database is the whole of the exposure and no less so for
 * being read-only. Two applications that genuinely share a volume are told to
 * rename it in one of the manifests, which is the only way to make the storage
 * attributable at all.
 *
 * The residual gap is now only a volume Rudder did not name and nothing declares
 * yet — a `pgdata` created by hand on the worker. There is no ownership record
 * for such a name, so "nobody else claims it" really is the most that can be
 * asked.
 */
export async function assertNotSharedWithOthers(
  app: typeof applications.$inferSelect,
  worker: typeof workers.$inferSelect,
  volume: AppVolume,
  action: SharedVolumeAction,
): Promise<void> {
  assertNotAnotherApps(volume, action);
  if (volume.origin !== 'shared') return;

  const others = await otherAppsUsing(volume.name, app.id, worker);
  if (others.length === 0) return;

  throw new AuthorizationError(
    `"${volume.name}" is not scoped to this application — it is also used by ` +
      `${others.map((n) => `"${n}"`).join(', ')} on worker "${worker.name}". ` +
      `${SHARED_CONSEQUENCE[action]}. Rename the volume in one of the manifests first.`,
    409,
  );
}
