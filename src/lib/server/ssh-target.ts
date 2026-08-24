/**
 * What a worker may be called, and where it may be reached.
 *
 * These three fields are typed by an operator and then handed to two places
 * that treat them as more than data:
 *
 * - `hostname` and `sshUser` become the `user@host` argument of an `ssh`
 *   invocation. It is passed as argv and never through a local shell (see
 *   `ssh.ts`), which stops `$(...)` — but not a value that *starts with a
 *   dash*. `ssh` has no `--` terminator for its destination, so a user of
 *   `-oProxyCommand=…` is read as an option and runs a command on the control
 *   plane itself, as the Rudder process.
 * - `name` is substituted into `provision.sh`, which runs on the worker as root,
 *   inside a double-quoted `echo`. `$(...)` and backticks there are root on the
 *   worker.
 *
 * Both are reachable only by an admin. That is not the same as being harmless:
 * an admin account in Rudder is meant to manage workers, not to be a shell on
 * the control-plane host, and the two blast radiuses are different enough to be
 * worth keeping apart.
 *
 * Errors rather than exceptions, and a plain module with no dependencies, so
 * the form actions, the JSON schemas and the SSH layer can all apply the same
 * rule — this mirrors `domainFormatError` in `domains.ts`, which exists for the
 * same reason. Returns a message describing the problem, or null when the value
 * is usable.
 */

/** DNS labels, or a bare IPv4 address. Deliberately no IPv6: `https://<host>` would need brackets. */
const HOSTNAME =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** A login name. Leading dash excluded by the character class, not by a separate check. */
const SSH_USER = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;

/** A worker name, matching `schemas.createWorker`. */
const WORKER_NAME = /^[a-zA-Z0-9_-]+$/;

export function hostnameFormatError(value: string): string | null {
  const host = value.trim();
  if (!host) return 'A hostname is required.';
  if (host.length > 253) return 'A hostname may be at most 253 characters.';
  if (!HOSTNAME.test(host)) {
    return (
      `"${value}" is not a usable hostname. Use a DNS name such as worker.example.com or an ` +
      `IPv4 address — letters, digits, dots and dashes only, and not starting with a dash.`
    );
  }
  return null;
}

export function sshUserFormatError(value: string): string | null {
  const user = value.trim();
  if (!user) return 'An SSH user is required.';
  if (!SSH_USER.test(user)) {
    return (
      `"${value}" is not a usable SSH user. Use letters, digits, underscores, dots and dashes, ` +
      `starting with a letter, digit or underscore.`
    );
  }
  return null;
}

/**
 * A worker name that is safe to substitute into the provisioning script.
 *
 * The name is not only a label: `generateProvisioningScript` interpolates it
 * into shell text, and — with no base domain configured — into the ACME contact
 * address as well.
 */
export function workerNameFormatError(value: string): string | null {
  const name = value.trim();
  if (!name) return 'A name is required.';
  if (name.length > 100) return 'A name may be at most 100 characters.';
  if (!WORKER_NAME.test(name)) {
    return (
      `"${value}" is not a usable worker name. Use letters, digits, underscores and hyphens — ` +
      `the name is substituted into the provisioning script that runs on the worker.`
    );
  }
  return null;
}

/**
 * The first problem among a worker's three shell-facing fields, or null.
 *
 * One call so a route cannot check two of them and forget the third, which is
 * how the create and edit forms came to check the base domain and nothing else.
 */
export function workerTargetError(worker: {
  name: string;
  hostname: string;
  sshUser: string;
}): string | null {
  return (
    workerNameFormatError(worker.name) ??
    hostnameFormatError(worker.hostname) ??
    sshUserFormatError(worker.sshUser)
  );
}
