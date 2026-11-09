/**
 * Verifying OAuth 2.0 access tokens issued as JWTs by an OIDC provider.
 *
 * The MCP endpoint is a resource server in OAuth terms: it never sees a login,
 * only the bearer token a client obtained from the identity provider (Keycloak
 * here). A token is accepted when the provider signed it, it is still in date,
 * and it is an *access* token for that provider — nothing else.
 *
 * Implemented on WebCrypto rather than a JOSE library. Verification of the
 * handful of asymmetric algorithms an IdP signs with is a few dozen lines, and
 * the list below is deliberately closed: `none` and the HMAC family are absent,
 * so a token cannot choose to be checked with a key the attacker knows.
 *
 * Network access goes through an injected `fetch` so the whole thing is tested
 * against keys generated in the test, without a provider.
 */

export class TokenError extends Error {
  constructor(
    message: string,
    /**
     * `invalid_token` — the token itself is bad; the client should get a new one.
     * `unavailable` — the provider could not be asked; retrying later may work.
     */
    public readonly code: 'invalid_token' | 'unavailable' = 'invalid_token',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  /** Keycloak: the client the token was issued to. */
  azp?: string;
  /** Keycloak: `Bearer` for access tokens, `ID` and `Refresh` for the others. */
  typ?: string;
  preferred_username?: string;
  email?: string;
  scope?: string;
  [claim: string]: unknown;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [field: string]: unknown;
}

type ImportParams = RsaHashedImportParams | EcKeyImportParams;
type VerifyParams = AlgorithmIdentifier | RsaPssParams | EcdsaParams;

/** The algorithms a token may be signed with. Asymmetric only, by construction. */
const ALGORITHMS: Record<string, { kty: string; importParams: ImportParams; verifyParams: VerifyParams }> = {
  RS256: { kty: 'RSA', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { kty: 'RSA', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { kty: 'RSA', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { kty: 'RSA', importParams: { name: 'RSA-PSS', hash: 'SHA-256' }, verifyParams: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { kty: 'RSA', importParams: { name: 'RSA-PSS', hash: 'SHA-384' }, verifyParams: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { kty: 'RSA', importParams: { name: 'RSA-PSS', hash: 'SHA-512' }, verifyParams: { name: 'RSA-PSS', saltLength: 64 } },
  // JWS carries ECDSA signatures as raw r||s, which is the form WebCrypto takes.
  ES256: { kty: 'EC', importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } },
  ES384: { kty: 'EC', importParams: { name: 'ECDSA', namedCurve: 'P-384' }, verifyParams: { name: 'ECDSA', hash: 'SHA-384' } },
  ES512: { kty: 'EC', importParams: { name: 'ECDSA', namedCurve: 'P-521' }, verifyParams: { name: 'ECDSA', hash: 'SHA-512' } },
};

/** No real access token comes near this; it bounds the work an anonymous caller can ask for. */
const MAX_TOKEN_LENGTH = 16 * 1024;
/** How long a fetched key set is trusted before it is fetched again. */
const JWKS_TTL_MS = 10 * 60_000;
/**
 * The soonest an unknown `kid` may trigger a refetch. Providers rotate keys, so
 * an unknown kid is a reason to look again — but not on every request, or a
 * stream of garbage tokens becomes a stream of requests to the provider.
 */
const JWKS_REFETCH_MIN_MS = 30_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_CLOCK_SKEW_S = 60;

export interface JwtVerifierOptions {
  /** Exact `iss` the provider puts in its tokens, e.g. `https://idp/realms/skoda`. */
  issuer: string;
  /** Skips discovery when set. */
  jwksUri?: string | null;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  clockSkewSeconds?: number;
}

function decodeSegment(segment: string, what: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new TokenError(`Malformed token ${what}`);
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError(`Malformed token ${what}`);
  }
}

export class JwtVerifier {
  readonly issuer: string;
  private readonly configuredJwksUri: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly skewS: number;

  private discovered: { jwksUri: string; at: number } | null = null;
  private jwks: { keys: Jwk[]; at: number } | null = null;
  private inflight: Promise<Jwk[]> | null = null;
  private readonly imported = new Map<string, CryptoKey>();

  constructor(options: JwtVerifierOptions) {
    this.issuer = options.issuer;
    this.configuredJwksUri = options.jwksUri || null;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.skewS = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_S;
  }

  /** Verify `token` and return its claims, or throw `TokenError`. */
  async verify(token: string): Promise<JwtClaims> {
    if (token.length > MAX_TOKEN_LENGTH) throw new TokenError('Token is too large');
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('Token is not a JWT');
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = decodeSegment(headerB64, 'header') as JwtHeader;
    if (!header || typeof header !== 'object') throw new TokenError('Malformed token header');
    const algorithm = header.alg ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm) throw new TokenError(`Token algorithm "${String(header.alg)}" is not accepted`);

    const claims = decodeSegment(payloadB64, 'payload') as JwtClaims;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new TokenError('Malformed token payload');

    // The issuer is checked before any key is fetched: a token from another
    // provider must not be able to make this one's key set be downloaded.
    if (claims.iss !== this.issuer) throw new TokenError('Token was not issued by the configured identity provider');

    if (!/^[A-Za-z0-9_-]+$/.test(signatureB64)) throw new TokenError('Malformed token signature');
    const signature = Buffer.from(signatureB64, 'base64url');
    const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const key = await this.keyFor(header, algorithm);
    const valid = await crypto.subtle.verify(algorithm.verifyParams, key, signature, signed);
    if (!valid) throw new TokenError('Token signature is invalid');

    const nowS = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== 'number') throw new TokenError('Token has no expiry');
    if (nowS - this.skewS >= claims.exp) throw new TokenError('Token has expired');
    if (typeof claims.nbf === 'number' && nowS + this.skewS < claims.nbf) {
      throw new TokenError('Token is not valid yet');
    }

    // Keycloak signs its ID and refresh tokens with the same key as its access
    // tokens and says which is which in `typ`. An ID token is proof that someone
    // logged in to *some* client, not a grant to call this API, so it is refused
    // here rather than accepted because the signature checks out.
    if (claims.typ !== undefined && String(claims.typ).toLowerCase() !== 'bearer') {
      throw new TokenError(`Token is a "${String(claims.typ)}" token, not an access token`);
    }

    return claims;
  }

  private async keyFor(header: JwtHeader, algorithm: (typeof ALGORITHMS)[string]): Promise<CryptoKey> {
    const cacheKey = `${header.alg}:${header.kid ?? ''}`;
    const cached = this.imported.get(cacheKey);
    if (cached) return cached;

    let jwk = this.select(await this.keys(false), header, algorithm.kty);
    if (!jwk && this.jwks && this.now() - this.jwks.at >= JWKS_REFETCH_MIN_MS) {
      // Possibly a rotated key. Look once more.
      jwk = this.select(await this.keys(true), header, algorithm.kty);
    }
    if (!jwk) throw new TokenError('Token was signed with a key the identity provider does not publish');

    let key: CryptoKey;
    try {
      const { alg: _alg, use: _use, key_ops: _ops, ...material } = jwk;
      key = await crypto.subtle.importKey('jwk', material as JsonWebKey, algorithm.importParams, false, ['verify']);
    } catch {
      throw new TokenError('Identity provider key could not be used for this token');
    }
    this.imported.set(cacheKey, key);
    return key;
  }

  private select(keys: Jwk[], header: JwtHeader, kty: string): Jwk | undefined {
    const usable = keys.filter(
      (k) =>
        k.kty === kty &&
        (k.use === undefined || k.use === 'sig') &&
        (k.alg === undefined || k.alg === header.alg),
    );
    if (header.kid !== undefined) return usable.find((k) => k.kid === header.kid);
    // No kid: only unambiguous when the provider publishes a single candidate.
    return usable.length === 1 ? usable[0] : undefined;
  }

  private async keys(force: boolean): Promise<Jwk[]> {
    if (!force && this.jwks && this.now() - this.jwks.at < JWKS_TTL_MS) return this.jwks.keys;
    // One fetch at a time; concurrent requests share it.
    this.inflight ??= this.fetchKeys().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchKeys(): Promise<Jwk[]> {
    const uri = await this.jwksUri();
    const body = (await this.getJson(uri, 'key set')) as { keys?: unknown };
    if (!Array.isArray(body?.keys)) throw new TokenError('Identity provider key set is malformed', 'unavailable');
    const keys = body.keys.filter((k): k is Jwk => !!k && typeof k === 'object');
    this.jwks = { keys, at: this.now() };
    // Imported keys may belong to a rotated-out set.
    this.imported.clear();
    return keys;
  }

  private async jwksUri(): Promise<string> {
    if (this.configuredJwksUri) return this.configuredJwksUri;
    if (this.discovered && this.now() - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered.jwksUri;

    const doc = (await this.getJson(`${this.issuer}/.well-known/openid-configuration`, 'discovery document')) as {
      issuer?: unknown;
      jwks_uri?: unknown;
    };
    // OIDC Discovery §4.3: the document must name the issuer it was fetched for.
    if (doc?.issuer !== this.issuer) {
      throw new TokenError(
        `Identity provider discovery names issuer "${String(doc?.issuer)}", expected "${this.issuer}"`,
        'unavailable',
      );
    }
    if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri) {
      throw new TokenError('Identity provider discovery has no jwks_uri', 'unavailable');
    }
    this.discovered = { jwksUri: doc.jwks_uri, at: this.now() };
    return doc.jwks_uri;
  }

  private async getJson(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TokenError(`Could not reach the identity provider for its ${what}: ${(e as Error).message}`, 'unavailable');
    }
    if (!response.ok) {
      throw new TokenError(`Identity provider answered ${response.status} for its ${what}`, 'unavailable');
    }
    try {
      return await response.json();
    } catch {
      throw new TokenError(`Identity provider ${what} is not JSON`, 'unavailable');
    }
  }
}
