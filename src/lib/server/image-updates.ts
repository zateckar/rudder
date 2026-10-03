/** Opt-in image checks. All pulls and deploy decisions run under the worker lock. */
import { db } from '$lib/db';
import { applications, containers, deployments, workers } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { desiredState } from './reconcile';
import { parseDigestRecord, sameRepository, serializeDigestRecord } from './image-digests';
import { getRestPodmanClient } from './podman-client';
import type { PodmanClient } from './podman';
import { mapWithConcurrency } from './concurrency';
import { DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES } from '$lib/image-update-settings';

type Application = typeof applications.$inferSelect;
type Worker = typeof workers.$inferSelect;
type ImageSource = Pick<PodmanClient, 'pullImage' | 'resolveImageDigest'>;

export function imageUpdateIsDue(
  app: Pick<Application, 'autoUpdateEnabled' | 'autoUpdateIntervalMinutes' | 'autoUpdateLastCheckedAt'>,
  now = Date.now(),
): boolean {
  if (!app.autoUpdateEnabled) return false;
  const minutes = app.autoUpdateIntervalMinutes || DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES;
  return !app.autoUpdateLastCheckedAt || now - app.autoUpdateLastCheckedAt.getTime() >= minutes * 60_000;
}

export interface ImageUpdate {
  pinnedDigests: string;
  images: string[];
}

/**
 * Compare tags with the generation actually serving, including after rollback.
 * A missing baseline is not evidence of a new image. Saved manifest changes
 * likewise need an explicit deploy before automatic checks can follow them.
 */
export async function resolveApplicationImageUpdate(
  app: Application,
  worker: Worker,
  source?: ImageSource,
): Promise<ImageUpdate | null> {
  const active = await db.select({ deploymentId: containers.deploymentId })
    .from(containers)
    .where(and(eq(containers.applicationId, app.id), eq(containers.state, 'active')))
    .all();
  const deploymentId = active[0]?.deploymentId;
  if (!deploymentId || active.some((row) => row.deploymentId !== deploymentId)) return null;

  const baseline = await db.select().from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.applicationId, app.id))).get();
  if (!baseline || !['succeeded', 'rolled_back'].includes(baseline.status) || baseline.manifest !== app.manifest) return null;

  const previous = parseDigestRecord(baseline.imageDigest);
  const images = new Map<string, string>();
  for (const { planned } of desiredState({ app, worker }).containers) {
    images.set(planned.digestKey ?? planned.key, planned.image);
  }
  if (images.size === 0) return null;

  // Establish a complete baseline before touching any tags. Replicas share a
  // digest key and services can share an image, so each tag is pulled once.
  const tags = new Set<string>();
  const resolved = new Map<string, string>();
  for (const [key, image] of images) {
    if (image.includes('@')) {
      resolved.set(key, image);
      continue;
    }
    const digest = previous.get(key);
    if (!digest || !sameRepository(digest, image)) return null;
    tags.add(image);
  }
  if (tags.size === 0) return null;

  const client = source ?? getRestPodmanClient(worker);
  const changed: string[] = [];
  try {
    const byImage = new Map<string, string>();
    for (const image of tags) {
      await client.pullImage(image);
      const digest = await client.resolveImageDigest(image);
      if (!digest || !sameRepository(digest, image)) {
        throw new Error(`Cannot determine the pulled digest for ${image}; automatic deployment skipped.`);
      }
      byImage.set(image, digest);
    }
    for (const [key, image] of images) {
      if (image.includes('@')) continue;
      const digest = byImage.get(image)!;
      resolved.set(key, digest);
      // Repository spelling can differ for Docker Hub shorthand. Compare bytes.
      if (digest.slice(digest.indexOf('@')) !== previous.get(key)!.slice(previous.get(key)!.indexOf('@'))) {
        if (!changed.includes(image)) changed.push(image);
      }
    }
    if (changed.length === 0) return null;
    const pinnedDigests = serializeDigestRecord(resolved);
    return pinnedDigests ? { pinnedDigests, images: changed } : null;
  } finally {
    if (!source) (client as PodmanClient).destroy();
  }
}

/** Compare the whole saved configuration, excluding our own scheduling write. */
export function imageUpdateConfigurationIsCurrent(before: Application, after: Application): boolean {
  const { autoUpdateLastCheckedAt: _beforeCheck, ...beforeConfig } = before;
  const { autoUpdateLastCheckedAt: _afterCheck, ...afterConfig } = after;
  return JSON.stringify(beforeConfig) === JSON.stringify(afterConfig);
}

/** Individual failures must not stall updates on other workers. */
export async function checkApplicationImageUpdates(): Promise<void> {
  const targets = await db.select({ app: applications }).from(applications)
    .innerJoin(workers, eq(applications.workerId, workers.id))
    .where(and(
      eq(applications.autoUpdateEnabled, true),
      eq(applications.desiredStatus, 'running'),
      eq(workers.status, 'online'),
    )).all();
  const due = targets.filter(({ app }) => imageUpdateIsDue(app));
  if (due.length === 0) return;
  const { executeApplicationDeploy } = await import('./deploy');
  await mapWithConcurrency(due, 3, async ({ app }) => {
    try {
      const result = await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
      // Lock contention and manual container stops are retried on a later tick.
      if (!result.success && result.statusCode !== 409) {
        console.error(`[image-updates] ${app.name}: ${result.message}`);
      }
    } catch (error) {
      console.error(`[image-updates] ${app.name}:`, error);
    }
  });
}

const DISPATCH_INTERVAL_MS = 60_000;

async function imageUpdateLoop(): Promise<void> {
  try {
    await checkApplicationImageUpdates();
  } catch (error) {
    console.error('[image-updates] Check cycle failed:', error);
  } finally {
    // Scheduling from completion prevents overlapping cycles after slow pulls.
    setTimeout(imageUpdateLoop, DISPATCH_INTERVAL_MS).unref?.();
  }
}

export function startImageUpdateChecks(): void {
  void imageUpdateLoop();
}
