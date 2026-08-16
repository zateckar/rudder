import { randomBytes } from 'crypto';

/**
 * Worker-level (global) OIDC support for the Traefik `traefik-oidc-auth`
 * plugin (github.com/sevensolutions/traefik-oidc-auth).
 *
 * The plugin is configured once per worker and attached to every application
 * router as `global-oidc@file`.  A single absolute `CallbackUri` on
 * `auth.<baseDomain>` serves all applications, so the identity provider needs
 * exactly one registered redirect URI per worker.
 */

/**
 * Shown wherever a user tries to save `allowedUserDomains`.  The plugin's
 * `AssertClaims` compares claim values with exact string equality — there is no
 * suffix or pattern form — so the restriction cannot be expressed and must not
 * be accepted and silently dropped.
 */
export const ALLOWED_DOMAINS_UNSUPPORTED =
  'Allowed user domains are not supported: the Traefik OIDC plugin matches claims by exact value, not by ' +
  'domain suffix. List individual addresses under "Allowed users", or restrict access at the identity provider.';

/** Path component of the shared callback URL. */
export const OIDC_CALLBACK_PATH = '/oidc/callback';

/** Hostname that terminates the shared OIDC callback for a worker. */
export function oidcCallbackHost(baseDomain: string): string {
  return `auth.${baseDomain}`;
}

/** The single redirect URI to register with the identity provider. */
export function oidcCallbackUrl(baseDomain: string): string {
  return `https://${oidcCallbackHost(baseDomain)}${OIDC_CALLBACK_PATH}`;
}

/**
 * The plugin's `Secret` must be exactly 32 characters — it is used directly as
 * an AES-256 key, and anything else makes the middleware fail to build, which
 * makes Traefik discard the whole dynamic config file.
 *
 * 16 random bytes hex-encoded is exactly 32 characters.
 */
export function generateOidcSecret(): string {
  return randomBytes(16).toString('hex');
}

/** True when `secret` is usable as the plugin's `Secret`. */
export function isValidOidcSecret(secret: string | null | undefined): secret is string {
  return typeof secret === 'string' && secret.length === 32;
}

/**
 * Coerce a stored session key into a valid plugin `Secret`.
 *
 * Keys minted before the plugin switch were 64 hex characters (32 *bytes*),
 * which the plugin rejects.  Returns the key unchanged when it is already
 * valid, otherwise a freshly generated one — callers must persist the result
 * so the secret stays stable across restarts, or every Traefik reload would
 * invalidate every session.
 */
export function normalizeOidcSecret(secret: string | null | undefined): {
  secret: string;
  rotated: boolean;
} {
  if (isValidOidcSecret(secret)) return { secret, rotated: false };
  return { secret: generateOidcSecret(), rotated: true };
}
