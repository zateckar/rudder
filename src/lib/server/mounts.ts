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
 * Named volumes are namespaced per application by the rules in `volumes.ts`, so
 * an application's *own* names are always allowed. A manifest may still write a
 * name out longhand, though, and a name Rudder generated for somebody else is
 * refused — see `assertVolumeOwnership`.
 */
import { env } from './env';
import { volumeOwnerApp8 } from './volumes';

export class MountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountPolicyError';
  }
}

/**
 * What a manifest asked for, before any policy is applied to it.
 *
 * Parsers emit these and nothing else. They used to emit finished bind strings
 * and half-resolved host paths, which meant each of the three deployment
 * formats decided independently what counted as a host path and what counted as
 * a volume — and got it differently. A compose file's named volume reached
 * `buildHostBind`, which rejected it for not being absolute; a Kubernetes
 * `emptyDir` was mapped to an empty host path and quietly filtered out.
 *
 * Turning an intent into something Podman accepts is `realizeMounts`, and that
 * is the only place the policy is applied.
 */
export type MountIntent =
  /** A directory on the worker's filesystem. Subject to the allow-list. */
  | { kind: 'bind'; source: string; target: string; mode: string }
  /** A named Podman volume, created on first use. Always permitted. */
  | { kind: 'volume'; name: string; target: string; mode: string }
  /** Memory-backed and gone when the container stops. */
  | { kind: 'tmpfs'; target: string; options?: string };

/**
 * Podman's own constraint on volume names. Rudder generates every name it
 * uses, so this is a guard against a naming rule drifting into something
 * Podman would read as a path rather than a volume.
 */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Default tmpfs options: writable, but never a route to privilege. */
export const DEFAULT_TMPFS_OPTS = 'rw,nosuid,nodev';

/** Validate a container-side mount path. */
function assertContainerPath(containerPath: string): string {
  const safe = normalizeHostPath(containerPath);
  if (safe === null || safe === '/') {
    throw new MountPolicyError(
      `Invalid container mount path "${containerPath}": must be an absolute path, below "/", ` +
        `without ".." segments.`,
    );
  }
  return safe;
}

/**
 * Refuse a volume whose name Rudder generated for a *different* application.
 *
 * Every naming rule in `volumes.ts` embeds `appId.slice(0, 8)`, so the name of
 * any volume Rudder created is an ownership record and `volumeOwnerApp8` reads
 * it back. That matters here because a manifest is authored by an ordinary team
 * member and a non-relative compose source is passed through verbatim — see
 * `parseCompose`. So `volumes: ["rudder-<someone-else8>-db-data:/data"]` is a
 * read-write mount of another team's database, on any worker the two
 * applications share, with no lookup involved.
 *
 * `requireAppVolume` already refuses the same names on the volume *management*
 * routes (`assertNotAnotherApps`), which is where backing one up or deleting it
 * goes. Mounting one bypassed all of that: the container reads and writes the
 * data directly and nothing in this path ever asked whose it was.
 *
 * Only names Rudder composed are refused. A bare `pgdata` names nothing in
 * particular and is left alone — two applications sharing one is a real
 * configuration, and the name carries no claim either way.
 */
function assertVolumeOwnership(name: string, owner: string | undefined): void {
  if (!owner) return;

  const named = volumeOwnerApp8(name);
  if (!named || named === owner.slice(0, 8)) return;

  throw new MountPolicyError(
    `Volume "${name}" belongs to another application: Rudder generated that name for ` +
      `application ${named}, not this one. Declaring another application's volume in a ` +
      `manifest does not transfer it — mount a volume of your own instead.`,
  );
}

/**
 * Build a validated `name:container:mode` spec for a named volume.
 *
 * `owner` is the application the mount is for, when there is one. Volumes
 * Rudder creates on its own behalf — the throwaway helper in `volume-ops` works
 * on a name it was handed — pass nothing and skip the ownership check.
 */
export function buildVolumeBind(
  name: string,
  containerPath: string,
  mode?: string,
  owner?: string,
): string {
  if (!VOLUME_NAME.test(name)) {
    throw new MountPolicyError(
      `"${name}" is not a usable volume name. Volume names must start with a letter or digit ` +
        `and contain only letters, digits, dots, dashes and underscores.`,
    );
  }
  assertVolumeOwnership(name, owner);
  return `${name}:${assertContainerPath(containerPath)}:${assertModeAllowed(mode)}`;
}

/**
 * Apply the mount policy to a container's intents, once.
 *
 * Returns the two shapes `createContainer` takes: `binds` for anything backed
 * by the filesystem or a volume, and `tmpfs` for anything backed by memory.
 *
 * `owner` names the application these mounts are for. Pass it whenever the
 * intents came from a manifest — it is what refuses another application's named
 * volume. It is optional only because `volume-ops` realizes mounts for Rudder's
 * own helper containers, whose names Rudder just generated.
 *
 * @throws MountPolicyError, which the deploy path reports as a 400 — a rejected
 * mount is a problem with the manifest, and the container must not start
 * without the storage it asked for.
 */
export function realizeMounts(
  intents: readonly MountIntent[],
  { owner }: { owner?: string } = {},
): { binds: string[]; tmpfs: Record<string, string> } {
  const binds: string[] = [];
  const tmpfs: Record<string, string> = {};

  for (const intent of intents) {
    switch (intent.kind) {
      case 'bind':
        binds.push(buildHostBind(intent.source, intent.target, intent.mode));
        break;
      case 'volume':
        binds.push(buildVolumeBind(intent.name, intent.target, intent.mode, owner));
        break;
      case 'tmpfs':
        tmpfs[assertContainerPath(intent.target)] = intent.options ?? DEFAULT_TMPFS_OPTS;
        break;
    }
  }

  return { binds, tmpfs };
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
  return `${safeHost}:${assertContainerPath(containerPath)}:${safeMode}`;
}

/** True when host path mounts are available at all. Useful for UI hints. */
export function hostMountsEnabled(): boolean {
  return PREFIXES.length > 0;
}
