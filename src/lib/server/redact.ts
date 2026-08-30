/**
 * Strip credentials out of a `podman inspect` payload before it leaves the server.
 *
 * The secrets store injects secrets into containers as environment variables, so
 * a container's `Config.Env` holds the plaintext of every secret bound to it.
 * Returning an inspect verbatim therefore hands any team member who can read the
 * application page the same values the secrets UI only discloses through an
 * audited reveal — and puts them in DevTools and in any exported HAR besides.
 *
 * The `/image` and worker Traefik/CrowdSec endpoints already narrowed their
 * responses for exactly this reason; this is the same rule applied to the one
 * endpoint that still passed the whole document through.
 */

/** Matches the export route, so a redaction reads the same wherever it appears. */
const REDACTED = '***REDACTED***';

/**
 * Environment variables whose values are worth reading and cannot be a secret.
 *
 * An allowlist rather than a "looks secret" denylist: the variables that carry
 * secrets are named by whoever wrote the manifest, so no pattern covers them.
 * `DATABASE_URL` and `SMTP_HOST` hold credentials under names no denylist would
 * flag, and being wrong in that direction discloses the thing this exists to
 * protect. Being wrong in this direction costs an operator a value they can
 * still get from the secrets UI, which records that they asked.
 */
const INERT_ENV_KEYS = new Set([
  'container',
  'HOME',
  'HOSTNAME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TZ',
  'USER',
]);

/** Flag names whose value is a credential, for the `Cmd`/`Entrypoint` rules below. */
const SECRET_FLAG = /(pass|secret|token|key|credential|auth)/i;

/**
 * Mask the values in a Podman env array, keeping the names.
 *
 * Which variables are set is the useful half of this for debugging and is not
 * sensitive; the values are the half that is.
 */
export function redactEnv(env: readonly string[]): string[] {
  return env.map((entry) => {
    const eq = entry.indexOf('=');
    // No `=` is a name with no value — nothing to hide.
    if (eq < 0) return entry;
    const key = entry.slice(0, eq);
    return INERT_ENV_KEYS.has(key) ? entry : `${key}=${REDACTED}`;
  });
}

/**
 * Mask credentials passed as command-line arguments.
 *
 * Narrower than `redactEnv` because the command a container runs is the first
 * thing an operator looks at and masking it wholesale would make the page
 * useless. Only two shapes are treated as secret-bearing: `--flag=value`, and a
 * bare `--flag` whose value is the argument after it.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;

  for (const arg of args) {
    if (maskNext) {
      out.push(REDACTED);
      maskNext = false;
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`);
      continue;
    }

    // A flag with no inline value takes the next argument as its value.
    if (eq < 0 && arg.startsWith('-') && SECRET_FLAG.test(arg)) maskNext = true;
    out.push(arg);
  }

  return out;
}

/**
 * Return a copy of a container inspect with its credential-bearing fields masked.
 *
 * Copies rather than mutates: the same inspect object is used server-side to
 * rebuild containers (`/api/containers/[id]/recreate` feeds `Config.Env`
 * straight back into `createContainer`), and redacting one in place there would
 * recreate the container with the literal string `***REDACTED***` as every
 * secret it has.
 */
export function redactContainerInspect<T>(inspect: T): T {
  const doc = inspect as any;
  if (!doc || typeof doc !== 'object' || !doc.Config) return inspect;

  const config = doc.Config;
  return {
    ...doc,
    Config: {
      ...config,
      ...(Array.isArray(config.Env) ? { Env: redactEnv(config.Env) } : {}),
      ...(Array.isArray(config.Cmd) ? { Cmd: redactArgs(config.Cmd) } : {}),
      ...(Array.isArray(config.Entrypoint) ? { Entrypoint: redactArgs(config.Entrypoint) } : {}),
    },
  } as T;
}
