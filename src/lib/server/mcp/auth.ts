/**
 * Authenticating a request to the MCP endpoint.
 *
 * Bearer tokens only, issued by the identity provider named in
 * `MCP_OIDC_ISSUER`. Nothing else is accepted here — not a session cookie, not a
 * Rudder API key — so the MCP surface has exactly one way in and its scope is
 * decided entirely by the token's audience (see teams.ts).
 *
 * Configuration is read from `process.env` on first use rather than through the
 * zod schema in env.ts, which is parsed once at import: the tests set these per
 * file, and an unset issuer has to mean "MCP is off", not "invalid environment".
 */
import { JwtVerifier, TokenError, type JwtClaims } from './jwt';
import { resolveTeams, teamNamesFromAudience, type Team } from './teams';

export interface McpConfig {
  issuer: string;
  jwksUri: string | null;
  /** Absolute URL of the MCP endpoint — the OAuth "resource". */
  resource: string;
  /** Origins a browser-based client may call from, beyond the resource's own. */
  allowedOrigins: string[];
}

/** Who is calling, and for which teams. */
export interface McpPrincipal {
  /** The token's `sub`. A service account for client-credentials tokens. */
  subject: string;
  /** `azp` — the Keycloak client the token was issued to. */
  clientId: string | null;
  /** `preferred_username`, when the token was issued to a person. */
  username: string | null;
  teams: Team[];
  /** Audiences that named a team which could not be resolved, and why. */
  skippedTeams: Array<{ name: string; reason: string }>;
}

export function publicUrl(): string {
  return (process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

/** Null when MCP is not configured, which disables the endpoint. */
export function mcpConfig(): McpConfig | null {
  const issuer = process.env.MCP_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  if (!issuer) return null;
  return {
    issuer,
    jwksUri: process.env.MCP_OIDC_JWKS_URI?.trim() || null,
    resource: `${publicUrl()}/mcp`,
    allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

let verifier: JwtVerifier | null = null;

function verifierFor(config: McpConfig): JwtVerifier {
  if (!verifier || verifier.issuer !== config.issuer) {
    verifier = new JwtVerifier({ issuer: config.issuer, jwksUri: config.jwksUri });
  }
  return verifier;
}

/** For tests: verify against a provider stub instead of the network. */
export function setVerifierForTests(v: JwtVerifier | null): void {
  verifier = v;
}

/** Where a client learns which authorization server to get a token from (RFC 9728). */
export function resourceMetadataUrl(): string {
  return `${publicUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export type AuthOutcome =
  | { ok: true; principal: McpPrincipal; claims: JwtClaims }
  | { ok: false; response: Response };

function challenge(status: number, error?: string, description?: string): Response {
  const params = [`resource_metadata="${resourceMetadataUrl()}"`];
  if (error) params.push(`error="${error}"`);
  if (description) params.push(`error_description="${description.replace(/["\\]/g, '')}"`);
  return new Response(JSON.stringify({ error: error ?? 'unauthorized', error_description: description }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer ${params.join(', ')}`,
    },
  });
}

export async function authenticateMcp(request: Request, config: McpConfig): Promise<AuthOutcome> {
  const header = request.headers.get('authorization');
  // RFC 6750 §3: no credentials at all gets a bare challenge, no error code.
  if (!header) return { ok: false, response: challenge(401) };
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return { ok: false, response: challenge(401, 'invalid_request', 'Expected a Bearer token') };

  let claims: JwtClaims;
  try {
    claims = await verifierFor(config).verify(match[1]);
  } catch (e) {
    if (e instanceof TokenError && e.code === 'unavailable') {
      console.error('[mcp] Token could not be verified:', e.message);
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'temporarily_unavailable', error_description: e.message }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
        }),
      };
    }
    if (e instanceof TokenError) return { ok: false, response: challenge(401, 'invalid_token', e.message) };
    throw e;
  }

  if (typeof claims.sub !== 'string' || !claims.sub) {
    return { ok: false, response: challenge(401, 'invalid_token', 'Token has no subject') };
  }

  const names = teamNamesFromAudience(claims.aud);
  const resolution = resolveTeams(names);
  for (const team of resolution.created) {
    console.log(`[mcp] Created team "${team.name}" (${team.slug}) for audience of ${claims.azp ?? claims.sub}`);
  }
  for (const skipped of resolution.skipped) {
    console.warn(`[mcp] Audience team "${skipped.name}" skipped: ${skipped.reason}`);
  }

  if (resolution.teams.length === 0) {
    // Authenticated, but entitled to nothing: 403 rather than 401, because a
    // fresh token from the same client would say the same thing.
    return {
      ok: false,
      response: challenge(
        403,
        'insufficient_scope',
        names.length === 0
          ? 'Token audience names no team. Expected an audience of the form <team>_<suffix>.'
          : 'Token audience names no team that could be resolved.',
      ),
    };
  }

  return {
    ok: true,
    claims,
    principal: {
      subject: claims.sub,
      clientId: typeof claims.azp === 'string' ? claims.azp : null,
      username: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
      teams: resolution.teams,
      skippedTeams: resolution.skipped,
    },
  };
}

/**
 * Whether a request's `Origin` may call the endpoint.
 *
 * The MCP transport spec requires this, against DNS rebinding. Native clients
 * send no Origin at all and are unaffected; a browser-based one must come from
 * Rudder's own origin or one listed in `MCP_ALLOWED_ORIGINS`.
 */
export function originAllowed(request: Request, config: McpConfig): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const normalized = origin.replace(/\/+$/, '');
  if (normalized === new URL(config.resource).origin) return true;
  return config.allowedOrigins.includes(normalized);
}
