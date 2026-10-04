/** Authorize storage before a deploy can remove or create containers. */
import { db } from '$lib/db';
import { applications, containers, teams, volumes, workers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { AuthorizationError } from './auth';
import { desiredState } from './reconcile';
import { realizeMounts } from './mounts';
import { volumeOwnerApp8 } from './volumes';
import type { DeploymentPlan } from './deploy/plan';
import type { Container, ContainerInspect, PodmanVolume } from './podman';

type Application = typeof applications.$inferSelect;
type Worker = typeof workers.$inferSelect;
type RegistryVolume = typeof volumes.$inferSelect;
export interface VolumeAccessSource {
  listContainers(all?: boolean): Promise<Container[]>;
  getContainer(id: string): Promise<ContainerInspect>;
  listVolumes(): Promise<PodmanVolume[]>;
}

function registryIds(raw: string | null): string[] {
  try {
    const mounts = JSON.parse(raw ?? '[]');
    return Array.isArray(mounts)
      ? mounts.flatMap((m) => typeof m?.volumeId === 'string' ? [m.volumeId] : [])
      : [];
  } catch { return []; }
}

function mountNames(inspect: ContainerInspect): Set<string> {
  const names = new Set<string>();
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type === 'volume' && mount.Name) names.add(mount.Name);
  }
  // Older Docker-compatible inspect responses report named mounts only here.
  for (const bind of inspect.HostConfig?.Binds ?? []) {
    const name = bind.split(':')[0];
    if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) names.add(name);
  }
  return names;
}

/** Whoever would mount the volumes: an application, or a team about to create one. */
export interface VolumeClaimant {
  appId: string | null;
  teamId: string | null;
}

/** What the worker holds and which of its containers mount which names. */
export interface WorkerVolumeEvidence {
  present: Set<string>;
  observed: { id: string; names: Set<string> }[];
}

export async function inspectWorkerVolumes(source: VolumeAccessSource): Promise<WorkerVolumeEvidence> {
  try {
    const present = new Set((await source.listVolumes()).map((v) => v.name));
    const observed: WorkerVolumeEvidence['observed'] = [];
    for (const live of await source.listContainers(true)) {
      observed.push({ id: live.Id, names: mountNames(await source.getContainer(live.Id)) });
    }
    return { present, observed };
  } catch {
    throw new AuthorizationError('Could not verify volume ownership on the worker. Retry when its container and volume APIs are available.', 502);
  }
}

/** Every recorded application on the worker and the registry volumes they reference. */
function readOwnership(worker: Worker): { workerApps: Application[]; registryRows: RegistryVolume[] } {
  const workerApps = db.select().from(applications).where(eq(applications.workerId, worker.id)).all();
  const ids = [...new Set(workerApps.flatMap((a) => registryIds(a.volumes)))];
  const registryRows = ids.length ? db.select().from(volumes).where(inArray(volumes.id, ids)).all() : [];
  return { workerApps, registryRows };
}

/**
 * The bare names in `requested` that `claimant` may not mount, each with the
 * reason, in the order `assertDeploymentVolumeAccess` meets them, so its first
 * entry is the error a deploy reports.
 *
 * Synchronous on purpose: ownership is read in one go after the worker was
 * inspected (see the caller).
 */
function volumeRefusals(
  claimant: VolumeClaimant,
  worker: Worker,
  requested: Set<string>,
  evidence: WorkerVolumeEvidence,
  workerApps: Application[],
  registryRows: RegistryVolume[],
): Map<string, string> {
  const refused = new Map<string, string>();
  const refuse = (name: string, reason: string) => { if (!refused.has(name)) refused.set(name, reason); };
  const sameOwner = (other: Application) => other.id === claimant.appId ||
    (!!claimant.teamId && other.teamId === claimant.teamId);

  const rows = db.select().from(containers).where(eq(containers.workerId, worker.id)).all();
  const appById = new Map(workerApps.map((a) => [a.id, a]));
  const byId = new Map(rows.map((r) => [r.containerId, r]));
  const attributable = new Set<string>();
  for (const live of evidence.observed) {
    // Names and application labels alone do not transfer a container's data
    // to a tenant. Adoption records its concrete worker container id.
    const row = byId.get(live.id);
    const owner = row?.applicationId ? appById.get(row.applicationId) : undefined;
    for (const name of requested) {
      if (!live.names.has(name)) continue;
      if (!owner || !sameOwner(owner)) {
        refuse(name, `Volume "${name}" is mounted by a container outside this application's team.`);
        continue;
      }
      attributable.add(name);
    }
  }

  const teamIds = [...new Set(workerApps.flatMap((a) => a.teamId ? [a.teamId] : []))];
  const teamRows = teamIds.length ? db.select().from(teams).where(inArray(teams.id, teamIds)).all() : [];
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const volumeRegistry = new Map(registryRows.map((v) => [v.id, { name: v.name, containerPath: v.containerPath }]));
  for (const other of workerApps) {
    if (sameOwner(other)) continue;
    let declared: Set<string>;
    try {
      const desired = desiredState({ app: other, worker, team: teamById.get(other.teamId ?? ''), volumeRegistry });
      declared = new Set(desired.containers.flatMap((c) => c.planned.mounts.flatMap((m) => m.kind === 'volume' ? [m.name] : [])));
    } catch {
      // A broken manifest cannot erase ownership: live mounts are checked above.
      continue;
    }
    for (const name of requested) {
      // Saving a manifest cannot take ownership away from an existing mount.
      if (!attributable.has(name) && declared.has(name)) refuse(name, `Volume "${name}" is reserved by another application team. Use an application-scoped volume.`);
    }
  }

  for (const name of requested) {
    if (evidence.present.has(name) && !attributable.has(name)) {
      refuse(name, `Volume "${name}" already exists on the worker without an attributable application mount. Adopt its container or recover it into an application-scoped volume before deploying.`);
    }
  }
  return refused;
}

/**
 * Which of `names` a new application of `teamId` could mount on `worker` today,
 * by the same rules a deploy enforces: name → reason it would be refused, or
 * null. Advisory — it takes no lock, and the deploy decides again.
 *
 * Throws the 502 `AuthorizationError` when the worker cannot be inspected.
 */
export async function bareVolumeAccessForTeam(
  teamId: string,
  worker: Worker,
  names: string[],
  source: VolumeAccessSource,
): Promise<Map<string, string | null>> {
  const requested = new Set(names.filter((n) => !volumeOwnerApp8(n)));
  const result = new Map<string, string | null>(names.map((n) => [n, null]));
  if (requested.size === 0) return result;
  const evidence = await inspectWorkerVolumes(source);
  const { workerApps, registryRows } = readOwnership(worker);
  const refused = volumeRefusals({ appId: null, teamId }, worker, requested, evidence, workerApps, registryRows);
  for (const [name, reason] of refused) result.set(name, reason);
  return result;
}

/**
 * Physical names are preserved, including adopted bare volumes. A declaration
 * reserves a new name, but cannot establish ownership of existing worker data.
 * That requires a live mount belonging to a recorded application. Orphaned
 * bare volumes fail closed; operators can adopt their existing container or
 * recover the data into an application-scoped volume.
 *
 * Caller holds workerDeployLock throughout validation and execution. This
 * serializes two tenants attempting the same previously absent bare name.
 */
export async function assertDeploymentVolumeAccess(
  app: Application,
  worker: Worker,
  plan: DeploymentPlan,
  source: VolumeAccessSource,
): Promise<void> {
  for (const container of plan.containers) realizeMounts(container.mounts, { owner: app.id });
  const requested = new Set(plan.containers.flatMap((c) => c.mounts.flatMap((m) =>
    m.kind === 'volume' && !volumeOwnerApp8(m.name) ? [m.name] : [],
  )));
  const evidence: WorkerVolumeEvidence = requested.size
    ? await inspectWorkerVolumes(source)
    : { present: new Set(), observed: [] };

  // Worker inspection yields to concurrent application edits. Read all current
  // ownership together synchronously afterward; old team membership must never
  // authorize a newly transferred application or mount registry entry.
  const { workerApps, registryRows } = readOwnership(worker);
  const current = workerApps.find((a) => a.id === app.id);
  if (!current || current.teamId !== app.teamId || current.workerId !== app.workerId ||
      current.manifest !== app.manifest || current.volumes !== app.volumes || current.type !== app.type) {
    throw new AuthorizationError('Application storage configuration changed during verification. Retry the deployment.', 409);
  }
  const registry = new Map(registryRows.map((v) => [v.id, v]));
  for (const id of registryIds(app.volumes)) {
    const volume = registry.get(id);
    if (!volume || (volume.teamId && volume.teamId !== app.teamId) || (volume.workerId && volume.workerId !== worker.id)) {
      throw new AuthorizationError('A referenced volume is unavailable to this application team or worker.', 409);
    }
  }
  if (requested.size === 0) return;

  const [first] = volumeRefusals({ appId: app.id, teamId: app.teamId }, worker, requested, evidence, workerApps, registryRows).values();
  if (first) throw new AuthorizationError(first, 409);
}
