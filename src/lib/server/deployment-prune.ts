/**
 * Pruning an application's old deployments, and the images only they used.
 *
 * Every deploy leaves a history row and, on the worker, the image it pulled.
 * Neither is ever cleaned up by Rudder: the worker-wide prune on the Workers
 * page is admin-only and indiscriminate, so the people who own an application
 * had no way to say "I am done with versions 1 to 40" — and an image an old
 * deployment pinned by digest stays on the worker for as long as anything
 * might roll back to it.
 *
 * What is safe to remove is decided here, in one pure function, against the
 * worker's actual image list:
 *
 * - The newest `keep` deployments stay, and so does every deployment that is
 *   still load-bearing whatever its age — the one serving traffic, one whose
 *   containers are still on the worker (a retained generation is a fast
 *   rollback target), and one that has not finished.
 * - An image goes only if a pruned deployment referenced it and nothing that
 *   stays does: no kept deployment of this application, no deployment of any
 *   other application on the same worker, and no container on the worker at
 *   all, running or not. Images are matched by what Podman actually holds —
 *   `RepoDigests` for a pinned digest, `RepoTags` for a tag — so `nginx:latest`
 *   in an old row and in the current one resolve to the same image, and that
 *   image is kept.
 *
 * Removal never forces. Podman's own "image is in use" refusal is the last
 * word, and is reported as skipped rather than overridden.
 */
import { db } from '$lib/db';
import { applications, auditLogs, containers, deployments, workers } from '$lib/db/schema';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { AuthorizationError } from './auth';
import { PodmanApiError } from './podman';
import { withPodman } from './podman-client';
import { normalizeRepository, parseDigestRecord, repositoryOf } from './image-digests';
import { LockError, withLock, workerDeployLock } from './locks';

/** The fewest deployments a prune may keep: the history must not be emptied. */
export const MIN_KEEP = 1;

export interface PruneDeployment {
  id: string;
  version: number;
  status: string;
  image: string | null;
  imageDigest: string | null;
}

/** An image as the worker lists it. Field names as Podman sends them. */
export interface WorkerImage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Size?: number;
}

/** Why a deployment older than the cut-off is kept anyway. */
export type KeptReason = 'current' | 'containers' | 'in progress';

export interface PrunePlan {
  /** Deployments whose rows go, newest first. */
  deployments: { id: string; version: number; status: string }[];
  /** Older than the cut-off, but load-bearing. */
  keptAnyway: { id: string; version: number; reason: KeptReason }[];
  /** Images that go with them. */
  images: { id: string; refs: string[]; sizeBytes: number }[];
  reclaimableBytes: number;
}

export interface PlanPruneInput {
  /** This application's deployments, in any order. */
  deployments: PruneDeployment[];
  keep: number;
  /** Deployment ids that containers on the worker were created by. */
  withContainers: ReadonlySet<string>;
  images: WorkerImage[];
  /** Image ids any container on the worker is created from. */
  imagesInUse: ReadonlySet<string>;
  /** Image references other applications on this worker have deployed. */
  otherReferences: Iterable<string>;
}

/** Every image reference a deployment row names: its tag and its pinned digests. */
export function deploymentImageRefs(dep: Pick<PruneDeployment, 'image' | 'imageDigest'>): string[] {
  const refs = new Set<string>();
  if (dep.image) refs.add(dep.image);
  for (const digest of parseDigestRecord(dep.imageDigest).values()) refs.add(digest);
  return [...refs];
}

/** `sha256:abc…` and `abc…` are the same image id; Podman sends both spellings. */
function normalizeImageId(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
}

/**
 * `repo:tag` in one spelling, so `nginx`, `docker.io/library/nginx:latest` and
 * Podman's own `docker.io/library/nginx:latest` compare equal. Locally built
 * images are listed under `localhost/`, which a manifest never writes.
 */
function normalizeTagRef(ref: string): string {
  const repo = repositoryOf(ref);
  const tag = ref.length > repo.length ? ref.slice(repo.length + 1) : 'latest';
  let normalized = normalizeRepository(repo);
  if (normalized.startsWith('localhost/')) normalized = normalized.slice('localhost/'.length);
  return `${normalized}:${tag}`;
}

/** The ids of the worker's images a reference resolves to. */
export function imagesForRef(ref: string, images: readonly WorkerImage[]): string[] {
  const at = ref.indexOf('@sha256:');
  if (at !== -1) {
    // The digest alone identifies the manifest; the repository part is spelled
    // however the deploy happened to spell it.
    const suffix = ref.slice(at);
    return images
      .filter((img) => (img.RepoDigests ?? []).some((d) => d.endsWith(suffix)))
      .map((img) => normalizeImageId(img.Id));
  }
  const wanted = normalizeTagRef(ref);
  return images
    .filter((img) => (img.RepoTags ?? []).some((t) => normalizeTagRef(t) === wanted))
    .map((img) => normalizeImageId(img.Id));
}

/** Decide what a prune removes. Pure; `pruneDeployments` does the I/O. */
export function planPrune(input: PlanPruneInput): PrunePlan {
  const keep = Math.max(MIN_KEEP, Math.floor(input.keep));
  const ordered = [...input.deployments].sort((a, b) => b.version - a.version);

  // The newest finished one is what is serving — a rollback writes its own
  // `rolled_back` row, and that row is what runs afterwards.
  const current = ordered.find((d) => d.status === 'succeeded' || d.status === 'rolled_back');

  const reasonFor = (d: PruneDeployment): KeptReason | null => {
    if (d.id === current?.id) return 'current';
    if (input.withContainers.has(d.id)) return 'containers';
    if (d.status === 'pending' || d.status === 'running') return 'in progress';
    return null;
  };

  const kept: PruneDeployment[] = ordered.slice(0, keep);
  const plan: PrunePlan = { deployments: [], keptAnyway: [], images: [], reclaimableBytes: 0 };
  const pruned: PruneDeployment[] = [];
  for (const d of ordered.slice(keep)) {
    const reason = reasonFor(d);
    if (reason) {
      kept.push(d);
      plan.keptAnyway.push({ id: d.id, version: d.version, reason });
    } else {
      pruned.push(d);
      plan.deployments.push({ id: d.id, version: d.version, status: d.status });
    }
  }

  const protectedIds = new Set([...input.imagesInUse].map(normalizeImageId));
  const keptRefs = [...kept.flatMap(deploymentImageRefs), ...input.otherReferences];
  for (const ref of keptRefs) {
    for (const id of imagesForRef(ref, input.images)) protectedIds.add(id);
  }

  const byId = new Map(input.images.map((img) => [normalizeImageId(img.Id), img]));
  const removable = new Map<string, Set<string>>();
  for (const ref of pruned.flatMap(deploymentImageRefs)) {
    for (const id of imagesForRef(ref, input.images)) {
      if (protectedIds.has(id)) continue;
      removable.set(id, (removable.get(id) ?? new Set()).add(ref));
    }
  }

  for (const [id, refs] of removable) {
    const sizeBytes = byId.get(id)?.Size ?? 0;
    plan.images.push({ id, refs: [...refs].sort(), sizeBytes });
    plan.reclaimableBytes += sizeBytes;
  }
  plan.images.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return plan;
}

export interface PruneResult extends PrunePlan {
  /** False for a preview: nothing was touched. */
  applied: boolean;
  /** Image ids actually removed, including ones that had already gone. */
  removedImages: string[];
  /** Images Podman refused or failed to remove, with its reason. */
  skippedImages: { id: string; reason: string }[];
}

/**
 * Plan a prune of `app`'s history against its worker, and carry it out unless
 * `dryRun`.
 *
 * Carried out under the worker's deploy lock, because a deploy running
 * alongside would be creating a container from an image this has just judged
 * unused, and writing a deployment row this has not seen.
 *
 * The worker has to be reachable even for a preview: without its image list,
 * "which images would go" has no answer, and deleting the history first would
 * throw away the only record of which images belonged to it.
 */
export async function pruneDeployments(
  app: typeof applications.$inferSelect,
  keep: number,
  { dryRun, userId }: { dryRun: boolean; userId: string | null },
): Promise<PruneResult> {
  if (!Number.isFinite(keep) || keep < MIN_KEEP) {
    throw new AuthorizationError(`Keep at least ${MIN_KEEP} deployment.`, 400);
  }
  if (!app.workerId) {
    throw new AuthorizationError('This application is not assigned to a worker.', 409);
  }
  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) throw new AuthorizationError('Worker not found', 404);
  if (!worker.podmanApiUrl) {
    throw new AuthorizationError(
      `Worker "${worker.name}" has no Podman API URL configured, so its images cannot be listed.`,
      409,
    );
  }

  const run = async (): Promise<PruneResult> => {
    const history = await db
      .select({
        id: deployments.id,
        version: deployments.version,
        status: deployments.status,
        image: deployments.image,
        imageDigest: deployments.imageDigest,
      })
      .from(deployments)
      .where(eq(deployments.applicationId, app.id))
      .orderBy(desc(deployments.version))
      .all();

    const containerRows = await db
      .select({ deploymentId: containers.deploymentId })
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();
    const withContainers = new Set(
      containerRows.map((r) => r.deploymentId).filter((id): id is string => !!id),
    );

    // Every other application on this worker, whatever its age: one of them
    // rolling back to a version that shares an image with ours must still find
    // it there.
    const others = await db
      .select({ image: deployments.image, imageDigest: deployments.imageDigest })
      .from(deployments)
      .innerJoin(applications, eq(applications.id, deployments.applicationId))
      .where(and(eq(applications.workerId, worker.id), ne(applications.id, app.id)))
      .all();

    let images: WorkerImage[];
    let imagesInUse: Set<string>;
    try {
      ({ images, imagesInUse } = await withPodman(worker, async (client) => {
        const [imageList, containerList] = await Promise.all([
          client.listImages(),
          client.listContainers(true),
        ]);
        return {
          images: imageList,
          imagesInUse: new Set(containerList.map((c) => c.ImageID).filter(Boolean)),
        };
      }));
    } catch (e: unknown) {
      throw new AuthorizationError(
        `Worker "${worker.name}" could not be reached, so its images cannot be checked: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        502,
      );
    }

    const plan = planPrune({
      deployments: history,
      keep,
      withContainers,
      images,
      imagesInUse,
      otherReferences: others.flatMap(deploymentImageRefs),
    });

    if (dryRun) return { ...plan, applied: false, removedImages: [], skippedImages: [] };

    const removedImages: string[] = [];
    const skippedImages: { id: string; reason: string }[] = [];
    await withPodman(worker, async (client) => {
      for (const image of plan.images) {
        try {
          await client.removeImage(image.id, false);
          removedImages.push(image.id);
        } catch (e: unknown) {
          if (PodmanApiError.hasStatus(e, 404)) {
            // Gone already — by hand, or by the worker-wide prune. Same outcome.
            removedImages.push(image.id);
          } else {
            skippedImages.push({
              id: image.id,
              reason: e instanceof PodmanApiError ? e.detail : e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    });

    if (plan.deployments.length > 0) {
      await db.delete(deployments).where(
        and(
          eq(deployments.applicationId, app.id),
          inArray(deployments.id, plan.deployments.map((d) => d.id)),
        ),
      );
    }

    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId,
      teamId: app.teamId,
      action: 'PRUNE_DEPLOYMENTS',
      resourceType: 'application',
      resourceId: app.id,
      details: JSON.stringify({
        keep,
        versions: plan.deployments.map((d) => d.version),
        removedImages,
        skippedImages: skippedImages.map((s) => s.id),
      }),
      createdAt: new Date(),
    });

    return { ...plan, applied: true, removedImages, skippedImages };
  };

  // A preview changes nothing, so it does not wait on — or block — a deploy.
  if (dryRun) return run();

  try {
    return await withLock(
      workerDeployLock(worker.id),
      { operation: `prune deployments of ${app.name}`, holder: crypto.randomUUID() },
      run,
    );
  } catch (e) {
    if (e instanceof LockError) {
      throw new AuthorizationError(
        'Another operation is running on this worker. Try again when it finishes.',
        409,
      );
    }
    throw e;
  }
}
