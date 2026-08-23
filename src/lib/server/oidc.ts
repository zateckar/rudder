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

/**
 * Identity headers the worker-level middleware puts on every request it lets
 * through to an application.  The names are oauth2-proxy's, because that is
 * what applications with a "trusted header" / "reverse proxy" login mode
 * already expect to read.
 *
 * An application may trust these for the same reason it may trust being
 * reachable at all: the middleware runs in front of it and the plugin *sets*
 * each name rather than appending to it, so a client that sends its own
 * `X-Forwarded-Email` has it overwritten before the backend sees it.  That
 * argument holds only while the request actually passes through the
 * middleware — the worker-level configuration declares no
 * `BypassAuthenticationRule`, and `IncludeWhen` defaults to `Authorized`, so
 * there is no path through it that reaches an application with these headers
 * unset and a client-supplied value intact.
 */
export const FORWARDED_IDENTITY_HEADERS = [
  'X-Forwarded-User',
  'X-Forwarded-Email',
  'X-Forwarded-Preferred-Username',
  'X-Forwarded-Groups',
] as const;

export const TOKEN_HEADER_INVALID =
  'A token header name may contain only letters, digits and hyphens, must start with a letter, ' +
  'and must be at most 64 characters — for example X-Auth-Request-Id-Token.';

/**
 * Names a token must not be delivered under.
 *
 * The identity headers are excluded because the middleware sets them itself and
 * the later definition would win, silently replacing a username with a JWT. The
 * rest are headers the proxy, the HTTP framing, or Traefik's own forwarded-header
 * handling owns; overwriting one breaks the request rather than the login.
 *
 * `Authorization` is deliberately *not* here. It is the one name an application
 * is most likely to already understand, and choosing it is the whole point of
 * making the name configurable — `renderGlobalOidcConfig` prefixes the value
 * with `Bearer ` when it is used.
 */
const RESERVED_TOKEN_HEADERS = new Set(
  [
    ...FORWARDED_IDENTITY_HEADERS,
    'Host',
    'Cookie',
    'Connection',
    'Content-Length',
    'Transfer-Encoding',
    'Upgrade',
    'TE',
    'Trailer',
    'Proxy-Authorization',
    'X-Forwarded-For',
    'X-Forwarded-Proto',
    'X-Forwarded-Host',
    'X-Forwarded-Port',
    'X-Forwarded-Uri',
    'X-Forwarded-Method',
    'X-Forwarded-Server',
    'X-Real-Ip',
  ].map((h) => h.toLowerCase()),
);

/** A stored token header name, trimmed, with "not set" collapsed to null. */
export function normalizeTokenHeader(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/**
 * Why `name` cannot be used to carry a token to an application, or null.
 *
 * The value becomes a YAML `Name:` in the generated middleware and then an HTTP
 * header name, so the character set is checked here rather than escaped later:
 * a name with a quote or a newline in it would be a way to write arbitrary
 * plugin configuration through a form field.
 */
export function tokenHeaderNameError(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) return TOKEN_HEADER_INVALID;
  if (RESERVED_TOKEN_HEADERS.has(name.toLowerCase())) {
    return `"${name}" is set by the proxy itself and cannot be used to carry a token. Pick another name.`;
  }
  return null;
}

/**
 * Validate an application's pair of token header names together.
 *
 * The two have to be checked as a pair because the same name for both would
 * make the second definition overwrite the first, and which token an
 * application then received would depend on the order the middleware happened
 * to be rendered in.
 */
export function tokenHeadersError(
  idTokenHeader: string | null | undefined,
  accessTokenHeader: string | null | undefined,
): string | null {
  const id = normalizeTokenHeader(idTokenHeader);
  const access = normalizeTokenHeader(accessTokenHeader);

  for (const name of [id, access]) {
    if (!name) continue;
    const error = tokenHeaderNameError(name);
    if (error) return error;
  }

  if (id && access && id.toLowerCase() === access.toLowerCase()) {
    return 'The ID token and access token must be forwarded under different header names.';
  }
  return null;
}

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
