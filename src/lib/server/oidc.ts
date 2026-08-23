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

/** Path component of the shared callback URL, when a worker names no other. */
export const OIDC_CALLBACK_PATH = '/oidc/callback';

/** The path an OIDC provider serves its discovery document from. */
const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';

/**
 * Reduce a provider URL to the issuer the plugin actually wants.
 *
 * `Provider.Url` is the *issuer* — the plugin appends `DISCOVERY_SUFFIX` to it
 * itself. Handing it the discovery URL therefore makes it request the path
 * twice and the provider answers 404, which the plugin only discovers on the
 * first request that reaches the middleware. Traefik reports the middleware as
 * loaded, the worker looks healthy, and every login fails:
 *
 *     [INFO]  Provider Url: https://idp.example.com/realms/x/.well-known/openid-configuration
 *     [ERROR] Error getting oidc discovery: HTTP error - Status code: 404 Not Found
 *
 * Pasting the discovery URL is the obvious mistake to make — it is the one URL
 * a provider's own documentation puts in front of you, and until this function
 * existed every field label here asked for it by name. Stripping the suffix is
 * unambiguous: there is exactly one issuer it could have come from, and no
 * legitimate issuer ends in it.
 */
export function normalizeIssuerUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  let value = url.trim();
  if (!value) return null;

  value = value.replace(/\/+$/, '');
  if (value.toLowerCase().endsWith(DISCOVERY_SUFFIX)) {
    value = value.slice(0, -DISCOVERY_SUFFIX.length).replace(/\/+$/, '');
  }

  return value || null;
}

/**
 * Rejected with this wherever a callback path is saved.
 *
 * The path is interpolated straight into the plugin's `CallbackUri` and has to
 * survive as a path: a query or fragment would be dropped from the redirect URI
 * the IdP compares against, and a relative path would make the plugin overlay
 * the wrapped service instead of using the shared auth host.
 */
export const CALLBACK_PATH_INVALID =
  'Callback path must start with "/" and contain no query string or fragment — for example /oidc/callback.';

/** True when `path` can be interpolated into the plugin's `CallbackUri`. */
export function isValidCallbackPath(path: string): boolean {
  return /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path);
}

/**
 * The callback path to use for a worker: its own, or the default.
 *
 * Identity providers compare redirect URIs by exact string, so a worker whose
 * IdP registration follows a different convention — `/oauth2/callback` is the
 * common one — needs the plugin to send that exact path or every login ends at
 * "invalid redirect_uri".  Stored per worker rather than per fleet because the
 * registration belongs to the worker's IdP client.
 */
export function resolveCallbackPath(path: string | null | undefined): string {
  return path && isValidCallbackPath(path) ? path : OIDC_CALLBACK_PATH;
}

/** Hostname that terminates the shared OIDC callback for a worker. */
export function oidcCallbackHost(baseDomain: string): string {
  return `auth.${baseDomain}`;
}

/** The single redirect URI to register with the identity provider. */
export function oidcCallbackUrl(baseDomain: string, callbackPath?: string | null): string {
  return `https://${oidcCallbackHost(baseDomain)}${resolveCallbackPath(callbackPath)}`;
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
