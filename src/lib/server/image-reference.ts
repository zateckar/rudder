/**
 * Is this string plausibly a container image reference?
 *
 * Deliberately not a full OCI grammar. The job is to catch the mistakes people
 * actually make in a form field — a blank, a stray JSON blob, a capitalised
 * repository, a space — and say so while they are still looking at the form.
 * Anything that gets past this is Podman's to judge; being stricter here would
 * mean rejecting legitimate references from registries nobody anticipated.
 *
 * The failure this exists to prevent: an unvalidated value was stored, and the
 * first sign of trouble was an HTTP 500 at deploy time quoting Podman's
 * "invalid reference format" back at a user who never typed that string.
 */

/** Tags are alphanumeric plus `_.-`, at most 128 characters, per the spec. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Only sha256 is in use; a digest that is not one is far more likely a typo. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * A registry host: `example.com`, `localhost`, `registry:5000`. Distinguished
 * from a path component by containing a dot or a colon, or being exactly
 * `localhost` — the same heuristic the reference spec uses.
 */
function looksLikeRegistry(component: string): boolean {
  return component === 'localhost' || component.includes('.') || component.includes(':');
}

/**
 * Why this is not a usable image reference, or null if it looks fine.
 *
 * The message names the specific problem: "must be lowercase" is actionable,
 * "invalid reference format" is not.
 */
export function imageReferenceError(reference: string): string | null {
  const ref = reference.trim();

  if (!ref) return 'Container image is required';
  if (/\s/.test(ref)) return `Image reference "${ref}" contains a space`;
  if (/^[{["']/.test(ref)) {
    return `"${ref}" does not look like an image reference — it looks like JSON`;
  }
  if (ref.length > 512) return 'Image reference is too long';

  // Split off the digest first: it is the only part allowed an `@`.
  let remainder = ref;
  const at = remainder.indexOf('@');
  if (at !== -1) {
    const digest = remainder.slice(at + 1);
    remainder = remainder.slice(0, at);
    if (!DIGEST.test(digest)) {
      return `"${digest}" is not a valid image digest — expected sha256: followed by 64 hex characters`;
    }
    if (!remainder) return 'Image reference has a digest but no repository';
  }

  // Then the tag, which is whatever follows the last colon that is not part of
  // a registry's port — a port only appears before the first slash.
  const lastColon = remainder.lastIndexOf(':');
  if (lastColon !== -1 && remainder.indexOf('/', lastColon) === -1) {
    const tag = remainder.slice(lastColon + 1);
    remainder = remainder.slice(0, lastColon);
    // `registry:5000` with no path is a host, not a repository with a tag.
    if (!remainder) return `"${ref}" has a tag but no image name`;
    if (!TAG.test(tag)) {
      return tag
        ? `"${tag}" is not a valid image tag`
        : `Image reference "${ref}" ends with a colon and no tag`;
    }
  }

  const components = remainder.split('/');
  if (components.some((c) => c === '')) {
    return `Image reference "${ref}" has an empty path segment`;
  }

  // The registry host may be mixed case; everything after it may not.
  const path = components.length > 1 && looksLikeRegistry(components[0])
    ? components.slice(1)
    : components;

  if (path.length === 0) return `"${ref}" names a registry but no image`;

  for (const component of path) {
    if (component !== component.toLowerCase()) {
      return `Image name "${path.join('/')}" must be lowercase`;
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(component)) {
      return `"${component}" is not a valid image name component`;
    }
  }

  return null;
}
