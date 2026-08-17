/**
 * What a worker is actually running for Traefik and CrowdSec, against what this
 * control plane would install.
 *
 * The images are pinned in `PLATFORM_IMAGES` and provisioning resolves them to
 * digests, which is what makes an upgrade a decision rather than a side effect
 * of some unrelated re-provision. That only helps if the difference is visible:
 * this is what tells an operator that a re-provision would move something.
 */
import { PLATFORM_IMAGES, type PlatformComponent } from './provisioning';
import type { PodmanClient } from './podman';

export interface PlatformComponentStatus {
  component: PlatformComponent;
  /** Container name on the worker; both run as fixed, well-known names. */
  containerName: string;
  /** Image reference the running container was created from, digest included. */
  runningImage: string | null;
  /** Version label of that image, when it carries one. */
  runningVersion: string | null;
  /** `repo:version` this control plane installs. */
  expectedImage: string;
  expectedVersion: string;
  /**
   * True when running and expected agree, false when they differ, null when the
   * running version could not be determined — an image with no version label,
   * or a worker that is not reachable. Null is not "fine": it means unknown,
   * and the UI says so rather than showing a reassuring tick.
   */
  upToDate: boolean | null;
}

const CONTAINER_NAMES: Record<PlatformComponent, string> = {
  traefik: 'traefik',
  crowdsec: 'crowdsec',
};

/**
 * Pull a version out of image metadata.
 *
 * `org.opencontainers.image.version` is the standard and both images set it.
 * Falling back to the reference's tag covers an image built without labels;
 * a digest reference has no tag, so that path yields null rather than a lie.
 */
export function versionFromLabels(
  labels: Record<string, string> | undefined,
  imageRef: string | null,
): string | null {
  const labelled =
    labels?.['org.opencontainers.image.version'] ??
    labels?.['org.label-schema.version'] ??
    null;
  if (labelled) return labelled;

  if (!imageRef || imageRef.includes('@sha256:')) return null;
  const lastColon = imageRef.lastIndexOf(':');
  if (lastColon === -1 || imageRef.lastIndexOf('/') > lastColon) return null;
  return imageRef.slice(lastColon + 1);
}

/** Compare a running version to the pinned one, tolerating a missing `v`. */
export function versionsMatch(running: string | null, expected: string): boolean | null {
  if (!running) return null;
  const strip = (v: string) => v.replace(/^v/, '').trim();
  return strip(running) === strip(expected);
}

/**
 * Inspect a worker's platform containers.
 *
 * Failures are reported as "unknown" per component rather than thrown: this
 * feeds an informational panel, and a worker whose CrowdSec is down should
 * still show its Traefik version.
 */
export async function getPlatformVersions(
  client: PodmanClient,
): Promise<PlatformComponentStatus[]> {
  let running: Awaited<ReturnType<PodmanClient['listContainers']>> = [];
  try {
    running = await client.listContainers(true);
  } catch {
    // Leave the list empty — every component reports unknown below.
  }

  const results: PlatformComponentStatus[] = [];

  for (const component of Object.keys(PLATFORM_IMAGES) as PlatformComponent[]) {
    const pinned = PLATFORM_IMAGES[component];
    const containerName = CONTAINER_NAMES[component];
    const expectedImage = `${pinned.repo}:${pinned.version}`;

    const container = running.find((c) =>
      (c.Names ?? []).some((n) => n.replace(/^\//, '') === containerName),
    );

    let runningImage: string | null = container?.Image ?? null;
    let labels: Record<string, string> | undefined = container?.Labels;
    // Which reference the version is read from. Separate from `runningImage`,
    // which stays the digest-pinned reference the container was created from —
    // that is the fact worth reporting, it just carries no version.
    let versionRef: string | null = runningImage;

    // The compat API's container labels do not always carry the image's own
    // labels, so fall back to inspecting the image when the version is missing.
    if (container && !versionFromLabels(labels, versionRef)) {
      try {
        const image = await client.getImageJson(container.ImageID || container.Image);
        labels = { ...(image.Config?.Labels ?? {}), ...(labels ?? {}) };
        if (!runningImage) runningImage = image.RepoTags?.[0] ?? null;

        // Provisioning pins by digest, so the container's reference is usually
        // `repo@sha256:…`, which has no tag to read a version out of. CrowdSec's
        // image sets no version label either, so it reported "unknown" while
        // Traefik — which does set one — reported fine. The image's own repo tag
        // is the same bytes by construction and does carry the version.
        if (!versionRef || versionRef.includes('@sha256:')) {
          const tagged = image.RepoTags?.find((t) => t && !t.endsWith(':<none>'));
          if (tagged) versionRef = tagged;
        }
      } catch {
        // Image gone or unreachable — stays unknown.
      }
    }

    const runningVersion = versionFromLabels(labels, versionRef);

    results.push({
      component,
      containerName,
      runningImage,
      runningVersion,
      expectedImage,
      expectedVersion: pinned.version,
      upToDate: versionsMatch(runningVersion, pinned.version),
    });
  }

  return results;
}
