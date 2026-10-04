import type { PageServerLoad } from './$types';
import { db, safeWorkerColumns } from '$lib/db';
import { applications, volumes, teams, workers, teamMembers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { requirePageUser } from '$lib/server/auth';
import { withPodman } from '$lib/server/podman-client';
import { registryVolumeName } from '$lib/server/volumes';
import { storageForApplications, unclaimedVolumes } from '$lib/server/app-volumes';

export const load: PageServerLoad = async (event) => {
  const currentUser = requirePageUser(event).user;
  const userId = currentUser.id;
  const { url } = event;

  // Get user's teams
  const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const teamIds = memberships.map(t => t.teamId);
  const urlTeam = url.searchParams.get('team');

  // Get volumes (admin sees all, others see their teams')
  let allVolumes: any[] = [];
  let teamApps: (typeof applications.$inferSelect)[] = [];
  const everything = currentUser.role === 'admin' && (!urlTeam || urlTeam === 'all');
  if (everything) {
    allVolumes = await db.select().from(volumes).all();
    teamApps = await db.select().from(applications).all();
  } else {
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
    }

    if (targetTeamIds.length > 0) {
      allVolumes = await db.select().from(volumes).where(inArray(volumes.teamId, targetTeamIds)).all();
      teamApps = await db.select().from(applications).where(inArray(applications.teamId, targetTeamIds)).all();
    } else {
      allVolumes = [];
    }
  }

  // Get teams and workers for the form
  const allTeams = currentUser.role === 'admin'
    ? await db.select().from(teams).all()
    : await db.select().from(teams).where(eq(teams.id, teamIds[0] || '')).all();
  
  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();

  // ── Real disk usage ────────────────────────────────────────────────────────
  //
  // This column rendered "—" for every row in every installation, because
  // `actualSizeMB` was hardcoded null — the usage was never fetched at all. It
  // is one `system/df` per worker, so it is grouped by worker rather than asked
  // per volume, and the workers are polled in parallel.
  //
  // A registry row's `name` is not the Podman volume name: the volume is
  // namespaced per application, so a size can only be attributed once the
  // application mounting it is known. Rows are matched by the suffix its
  // application prefix produces — see `registryVolumeName`.
  //
  // ── What is actually on the workers ───────────────────────────────────────
  //
  // The registry is only the volumes someone created on this page. A compose
  // file's `./data` or `models:` is a real Podman volume as well — created by
  // the deploy, holding data, costing disk — and this page did not list a
  // single one of them. They are read out of the same intent the deploy acts
  // on, via `storageForApplications`, which asks each worker once. Both go out
  // together, so the page waits for the slowest worker once rather than twice.
  const [enrichedVolumes, fleet] = await Promise.all([
    withActualSizes(allVolumes),
    storageForApplications(teamApps, { sizes: true }),
  ]);
  const appVolumes = fleet.applications.flatMap(({ app, worker, storage }) =>
    storage.volumes.map((v) => ({
      appId: app.id,
      appName: app.name,
      teamId: app.teamId,
      workerName: worker?.name ?? null,
      name: v.name,
      label: v.label,
      origin: v.origin,
      declared: v.declared,
      present: v.present,
      sizeBytes: v.sizeBytes,
      targets: v.targets,
      copies: v.copies.length,
    })),
  );
  const unreachableWorkers = [...fleet.workers.values()]
    .filter((w) => w.unreachable)
    .map((w) => w.worker.name);

  return {
    user: currentUser,
    volumes: enrichedVolumes,
    appVolumes,
    // Only when every application was in the fleet: with a partial list, a
    // neighbour's volume would read as nobody's. See `unclaimedVolumes`.
    unclaimedVolumes: everything
      ? unclaimedVolumes(fleet).map((v) => ({
          workerName: v.worker.name,
          name: v.name,
          sizeBytes: v.sizeBytes,
          createdAt: v.createdAt,
        }))
      : null,
    unreachableWorkers,
    teams: allTeams,
    workers: allWorkers,
  };
};

/** A registry row with the disk it actually occupies, where that can be found out. */
interface SizedVolume {
  actualSizeMB: number | null;
  /** The applications mounting it, so an unattributable row reads as such. */
  usedBy: string[];
}

/**
 * Attach real disk usage to registry rows.
 *
 * The awkward part is that a registry row does not know its own Podman name. A
 * registered volume is namespaced *per application* — `rudder-<app8>-<name>`,
 * see `registryVolumeName` — so one row referenced by two applications is two
 * volumes on disk, and a row nothing references is no volume at all. The
 * application is therefore what the lookup is driven from, and `volumes.worker_id`
 * is ignored: it is advisory ("Any worker") and the volume lives wherever the
 * application that mounts it was deployed.
 *
 * Best-effort throughout. An offline worker, one with no Podman URL, or a row
 * nothing mounts leaves `actualSizeMB` null — which is what the column already
 * renders as "—", and is honest in a way that a zero would not be.
 */
async function withActualSizes<T extends { id: string; name: string }>(
  rows: T[],
): Promise<(T & SizedVolume)[]> {
  if (rows.length === 0) return [];

  const wanted = new Set(rows.map((r) => r.id));
  const apps = await db
    .select({
      id: applications.id,
      name: applications.name,
      workerId: applications.workerId,
      volumes: applications.volumes,
    })
    .from(applications)
    .all();

  /** volumeId → the applications referencing it, with the worker they run on. */
  const references = new Map<string, { appName: string; workerId: string; podmanName: string }[]>();
  for (const app of apps) {
    if (!app.workerId || !app.volumes) continue;
    let declared: unknown;
    try {
      declared = JSON.parse(app.volumes);
    } catch {
      continue;
    }
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      const volumeId = (entry as { volumeId?: string })?.volumeId;
      if (!volumeId || !wanted.has(volumeId)) continue;
      const row = rows.find((r) => r.id === volumeId)!;
      const list = references.get(volumeId) ?? [];
      list.push({
        appName: app.name,
        workerId: app.workerId,
        podmanName: registryVolumeName(app.id, row.name),
      });
      references.set(volumeId, list);
    }
  }

  const workerIds = [...new Set([...references.values()].flat().map((r) => r.workerId))];
  if (workerIds.length === 0) {
    return rows.map((r) => ({ ...r, actualSizeMB: null, usedBy: [] }));
  }

  const workerRows = await db.select().from(workers).where(inArray(workers.id, workerIds)).all();
  const usageByWorker = new Map<string, Map<string, number>>();
  await Promise.all(
    workerRows.map(async (worker) => {
      if (!worker.podmanApiUrl) return;
      try {
        usageByWorker.set(
          worker.id,
          await withPodman(worker, (client) => client.volumeUsage()),
        );
      } catch (e) {
        // One unreachable worker must not blank the whole table.
        console.warn(`[volumes] Could not read volume usage from "${worker.name}":`, e);
      }
    }),
  );

  return rows.map((row) => {
    const refs = references.get(row.id) ?? [];
    let bytes: number | null = null;
    for (const ref of refs) {
      const size = usageByWorker.get(ref.workerId)?.get(ref.podmanName);
      if (size === undefined) continue;
      bytes = (bytes ?? 0) + size;
    }
    return {
      ...row,
      actualSizeMB: bytes === null ? null : Math.round(bytes / (1024 * 1024)),
      usedBy: refs.map((r) => r.appName),
    };
  });
}

// No form actions here on purpose.
//
// The page writes through `/api/volumes` and `/api/volumes/[id]`, which is where
// the tenancy rules live: the POST requires an owning team and membership in it,
// and the per-volume routes resolve the volume through `requireVolumeAccess`.
//
// This file used to carry `create` and `delete` actions as well — a second,
// unauthorized write path that nothing in the UI called. They checked only that
// a session existed, so `create` trusted whatever `teamId` was posted (a volume
// planted in another team is mountable into that team's containers) and `delete`
// removed any volume by raw id. Adding the checks here would have meant
// maintaining the same rules in two places; the endpoints already have them.
