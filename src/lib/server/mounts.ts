/**
 * Host bind-mount policy.
 *
 * Application manifests are authored by ordinary team members, but the binds
 * they produce are handed straight to the Podman API on a worker.  An
 * unrestricted `hostPath` is therefore equivalent to root on that worker
 * (`/:/host:rw`, `/etc`, the Podman socket, …), so host paths are denied by
 * default and only permitted under prefixes an operator has explicitly
 * allow-listed via ALLOWED_HOST_MOUNT_PREFIXES.
 *
 * Named volumes go through the `volumes` table and are namespaced per
 * application, so they are always allowed.
 */
import { env } from './env';

export class MountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountPolicyError';
  }
}

/**
 * Paths that are never mountable, even if an operator allow-lists a parent.
 * These are the routes to container escape or host takeover; allow-listing `/`
 * or `/var` should not silently re-open them.
 */
const ALWAYS_DENIED = [
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/etc',
  '/root',
  '/run',
  '/var/run',
  '/var/lib/containers',
  '/var/lib/docker',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
];

const VALID_MODES = new Set([
  'rw', 'ro',
  'rw,z', 'ro,z', 'rw,Z', 'ro,Z',
  'z', 'Z',
]);

/**
 * Normalize a POSIX path: collapse duplicate slashes, resolve `.`/`..`, and
 * strip any trailing slash.  Returns null if the path is not absolute or
 * traverses above the root.
 */
export function normalizeHostPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  // Reject NUL and other control characters outright.
  if (/[\x00-\x1f]/.test(trimmed)) return null;

  const out: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null; // escapes above /
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return '/' + out.join('/');
}

/** Operator-configured prefixes, normalized once at module load. */
function allowedPrefixes(): string[] {
  return env.ALLOWED_HOST_MOUNT_PREFIXES.split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizeHostPath)
    .filter((p): p is string => p !== null && p !== '/');
}

const PREFIXES = allowedPrefixes();

/** True when `path` is `prefix` itself or lives beneath it. */
function isUnder(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * Validate a single host path against the mount policy.
 * @throws MountPolicyError with an operator-actionable message.
 */
export function assertHostPathAllowed(rawPath: string): string {
  const path = normalizeHostPath(rawPath);

  if (path === null) {
    throw new MountPolicyError(
      `Invalid host path "${rawPath}": must be an absolute path without ".." segments.`,
    );
  }

  if (path === '/') {
    throw new MountPolicyError('Mounting the host root "/" is not permitted.');
  }

  for (const denied of ALWAYS_DENIED) {
    if (isUnder(path, denied)) {
      throw new MountPolicyError(
        `Host path "${path}" is not mountable: "${denied}" is permanently denied.`,
      );
    }
  }

  if (PREFIXES.length === 0) {
    throw new MountPolicyError(
      `Host path mounts are disabled. Use a named volume, or set ALLOWED_HOST_MOUNT_PREFIXES ` +
        `to permit specific host directories.`,
    );
  }

  if (!PREFIXES.some((prefix) => isUnder(path, prefix))) {
    throw new MountPolicyError(
      `Host path "${path}" is outside the permitted mount prefixes (${PREFIXES.join(', ')}).`,
    );
  }

  return path;
}

/** Validate the mode/options segment of a bind spec. */
export function assertModeAllowed(rawMode: string | undefined): string {
  const mode = (rawMode || 'rw').trim();
  if (!VALID_MODES.has(mode)) {
    throw new MountPolicyError(
      `Invalid mount mode "${mode}". Allowed: ${[...VALID_MODES].join(', ')}.`,
    );
  }
  return mode;
}

/**
 * Build a validated `host:container:mode` bind string for a host path mount.
 * @throws MountPolicyError
 */
export function buildHostBind(
  hostPath: string,
  containerPath: string,
  mode?: string,
): string {
  const safeHost = assertHostPathAllowed(hostPath);
  const safeMode = assertModeAllowed(mode);

  const safeContainer = normalizeHostPath(containerPath);
  if (safeContainer === null) {
    throw new MountPolicyError(
      `Invalid container mount path "${containerPath}": must be an absolute path without ".." segments.`,
    );
  }

  return `${safeHost}:${safeContainer}:${safeMode}`;
}

/** True when host path mounts are available at all. Useful for UI hints. */
export function hostMountsEnabled(): boolean {
  return PREFIXES.length > 0;
}
