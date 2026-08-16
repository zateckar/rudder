/**
 * What `deployments.image_digest` holds, and how a redeploy reads it back.
 *
 * A deployment records the bytes it ran, not just the tag it was asked for.
 * Single-container applications have exactly one image, so the column holds a
 * bare reference: `docker.io/library/nginx@sha256:…`. Compose and Kubernetes
 * applications have one per service, so the column holds a JSON object keyed by
 * the name the deploy path uses for that container.
 *
 * Both shapes are read through `parseDigestRecord`, which is why the storage
 * format is allowed to differ: the single-image case is far more common and a
 * bare digest is legible in the database and in the UI, where a one-entry JSON
 * object would not be.
 *
 * Everything here is pure — no database, no Podman — so the format contract is
 * tested directly rather than through a deploy.
 */

/** Key used for the one image of a single-container application. */
export const SINGLE_IMAGE_KEY = '';

/**
 * Read a stored digest record.
 *
 * Accepts the bare-reference form, the JSON-object form, null, and anything
 * malformed — a record that cannot be parsed yields an empty map, so the
 * deploy falls back to the tag rather than failing. Losing digest pinning on
 * one historical row is recoverable; refusing to deploy over it is not.
 */
export function parseDigestRecord(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;

  const trimmed = raw.trim();
  if (!trimmed) return out;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.includes('@sha256:')) {
            out.set(key, value);
          }
        }
      }
    } catch {
      // Malformed JSON: treated as no record at all.
    }
    return out;
  }

  if (trimmed.includes('@sha256:')) {
    out.set(SINGLE_IMAGE_KEY, trimmed);
  }
  return out;
}

/**
 * Render digests for storage, choosing the shape from how many there are.
 *
 * Returns null when nothing resolved, which is the honest record for an image
 * the registry reports no digest for — a locally built image, say. A caller
 * must not substitute the tag here: that would claim byte-level provenance the
 * deploy does not have.
 */
export function serializeDigestRecord(entries: Iterable<[string, string]>): string | null {
  const list = [...entries].filter(([, digest]) => digest && digest.includes('@sha256:'));
  if (list.length === 0) return null;

  if (list.length === 1 && list[0][0] === SINGLE_IMAGE_KEY) {
    return list[0][1];
  }

  // Sorted so that redeploying the same set of services produces an identical
  // string, and a diff between two deployment rows shows only real changes.
  const sorted = [...list].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(sorted));
}

/**
 * The image reference a deploy should create a container from.
 *
 * `key` is the service name for compose/k8s, `SINGLE_IMAGE_KEY` for a
 * single-container app. Falls back to the manifest's image whenever no digest
 * was recorded for that key, so a rollback to a deployment from before digests
 * existed still deploys — by tag, as it always did.
 */
export function pinnedImageFor(
  key: string,
  record: Map<string, string>,
  manifestImage: string,
): string {
  const digest = record.get(key);
  if (!digest) return manifestImage;

  // A digest from a different image than the manifest now names is not a pin,
  // it is a mix-up — the manifest was edited between the two deployments. Trust
  // the manifest, which is what the user is looking at.
  if (!sameRepository(digest, manifestImage)) return manifestImage;

  return digest;
}

/**
 * Do a digest reference and a tagged reference name the same repository?
 *
 * Compared on the normalised repository only. `nginx`, `docker.io/nginx` and
 * `docker.io/library/nginx` are the same thing to a registry and must be the
 * same thing here, or every Docker Hub pin would be discarded as a mismatch.
 */
export function sameRepository(digestRef: string, taggedRef: string): boolean {
  return normalizeRepository(repositoryOf(digestRef)) === normalizeRepository(repositoryOf(taggedRef));
}

/** Strip the `@sha256:…` or `:tag` suffix, leaving the repository. */
export function repositoryOf(ref: string): string {
  const at = ref.indexOf('@');
  if (at !== -1) return ref.slice(0, at);

  const lastColon = ref.lastIndexOf(':');
  if (lastColon === -1) return ref;
  // A colon before the last slash is a registry port, not a tag separator.
  if (ref.lastIndexOf('/') > lastColon) return ref;
  return ref.slice(0, lastColon);
}

/** Expand Docker Hub shorthand so the three spellings of `nginx` compare equal. */
export function normalizeRepository(repo: string): string {
  let name = repo;
  if (name.startsWith('docker.io/')) name = name.slice('docker.io/'.length);
  if (name.startsWith('index.docker.io/')) name = name.slice('index.docker.io/'.length);

  const firstSegment = name.split('/')[0];
  const hasRegistry = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';
  if (hasRegistry) return name;

  if (!name.includes('/')) return `library/${name}`;
  return name;
}
