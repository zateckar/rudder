/**
 * The MCP server: token verification, audience → team mapping, and the
 * endpoint's tenancy.
 *
 * Tokens are signed here with keys generated per run and served from a stubbed
 * provider, so every path — good signature, wrong key, wrong issuer, expired, ID
 * token — is exercised against real WebCrypto, without Keycloak.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, auditLogs, deployments, teams } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { JwtVerifier, TokenError } from './jwt';
import { resolveTeams, teamNameFromAudience, teamNamesFromAudience } from './teams';
import { setVerifierForTests } from './auth';
import { clearTasksForTests, getTask, startTask } from './tasks';

const ISSUER = 'https://idp.example.test/realms/skoda';
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;

let rsa: CryptoKeyPair;
let otherRsa: CryptoKeyPair;
let ec: CryptoKeyPair;
let jwks: { keys: JsonWebKey[] };
let fetchCount = 0;

const providerFetch = (async (input: RequestInfo | URL) => {
  fetchCount++;
  const url = String(input);
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI });
  }
  if (url === JWKS_URI) return Response.json(jwks);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const b64url = (data: string | Uint8Array) =>
  Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data).toString('base64url');

async function sign(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; alg?: string; kid?: string } = {},
): Promise<string> {
  const alg = options.alg ?? 'RS256';
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid: options.kid ?? 'rsa-1' }));
  const payload = b64url(JSON.stringify(claims));
  const params = alg.startsWith('ES') ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await crypto.subtle.sign(
    params,
    options.key ?? rsa.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

function accessClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: 'service-account-podp',
    azp: 'mcppodp_x7f2',
    aud: ['mcppodp_x7f2', 'account'],
    typ: 'Bearer',
    exp: nowS() + 300,
    iat: nowS(),
    ...overrides,
  };
}

function verifier() {
  return new JwtVerifier({ issuer: ISSUER, fetch: providerFetch });
}

beforeAll(async () => {
  const rsaParams = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  rsa = (await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify'])) as CryptoKeyPair;
  otherRsa = (await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify'])) as CryptoKeyPair;
  ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwks = {
    keys: [
      { ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'rsa-1', use: 'sig', alg: 'RS256' } as JsonWebKey,
      { ...(await crypto.subtle.exportKey('jwk', ec.publicKey)), kid: 'ec-1', use: 'sig', alg: 'ES256' } as JsonWebKey,
    ],
  };
});

// ── Token verification ───────────────────────────────────────────────────────

describe('JwtVerifier', () => {
  test('accepts an access token the provider signed', async () => {
    const claims = await verifier().verify(await sign(accessClaims()));
    expect(claims.sub).toBe('service-account-podp');
  });

  test('accepts ES256', async () => {
    const claims = await verifier().verify(await sign(accessClaims(), { alg: 'ES256', kid: 'ec-1', key: ec.privateKey }));
    expect(claims.azp).toBe('mcppodp_x7f2');
  });

  test('refuses a token signed by a key the provider does not publish', async () => {
    // Same kid as the real key, so this is the signature check failing — not the lookup.
    const forged = await sign(accessClaims(), { key: otherRsa.privateKey });
    await expect(verifier().verify(forged)).rejects.toThrow('signature is invalid');
  });

  test('refuses another issuer without contacting any provider', async () => {
    const before = fetchCount;
    await expect(verifier().verify(await sign(accessClaims({ iss: 'https://evil.example.test' })))).rejects.toThrow(
      'not issued by the configured identity provider',
    );
    expect(fetchCount).toBe(before);
  });

  test('refuses an expired token, allowing for clock skew', async () => {
    await expect(verifier().verify(await sign(accessClaims({ exp: nowS() - 120 })))).rejects.toThrow('expired');
    // 30 s past expiry is inside the 60 s skew.
    await verifier().verify(await sign(accessClaims({ exp: nowS() - 30 })));
  });

  test('refuses a token with no expiry', async () => {
    await expect(verifier().verify(await sign(accessClaims({ exp: undefined })))).rejects.toThrow('no expiry');
  });

  test('refuses a Keycloak ID token even though the signature is good', async () => {
    await expect(verifier().verify(await sign(accessClaims({ typ: 'ID' })))).rejects.toThrow('not an access token');
  });

  test('refuses alg "none" and HMAC algorithms outright', async () => {
    const payload = b64url(JSON.stringify(accessClaims()));
    for (const alg of ['none', 'HS256']) {
      const header = b64url(JSON.stringify({ alg, kid: 'rsa-1' }));
      await expect(verifier().verify(`${header}.${payload}.`)).rejects.toThrow('is not accepted');
    }
  });

  test('refuses garbage as an invalid token, not an internal error', async () => {
    for (const token of ['', 'abc', 'a.b', 'a.b.c', '!!!.###.$$$']) {
      const error = await verifier().verify(token).catch((e) => e);
      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).code).toBe('invalid_token');
    }
  });

  test('an unreachable provider is "unavailable", not "invalid"', async () => {
    const down = new JwtVerifier({
      issuer: ISSUER,
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const error = await down.verify(await sign(accessClaims())).catch((e) => e);
    expect((error as TokenError).code).toBe('unavailable');
  });

  test('discovery naming a different issuer is refused', async () => {
    const lying = new JwtVerifier({
      issuer: ISSUER,
      fetch: (async () => Response.json({ issuer: 'https://other', jwks_uri: JWKS_URI })) as unknown as typeof fetch,
    });
    await expect(lying.verify(await sign(accessClaims()))).rejects.toThrow('discovery names issuer');
  });
});

// ── Audience → team ──────────────────────────────────────────────────────────

describe('audience mapping', () => {
  test('the team is the part before the first underscore', () => {
    expect(teamNameFromAudience('podp_x7f2')).toBe('podp');
    expect(teamNameFromAudience('podp_x7f2_more')).toBe('podp');
    expect(teamNameFromAudience('account')).toBeNull();
    expect(teamNameFromAudience('_x7f2')).toBeNull();
  });

  test('accepts a string or an array, and deduplicates case-insensitively', () => {
    expect(teamNamesFromAudience('hmi_1')).toEqual(['hmi']);
    expect(teamNamesFromAudience(['HMI_1', 'hmi_2', 'account', 7, 'podp_3'])).toEqual(['HMI', 'podp']);
    expect(teamNamesFromAudience(undefined)).toEqual([]);
  });

  test('creates a team that does not exist, once', () => {
    const first = resolveTeams(['mcp-brand-new-team']);
    expect(first.created.map((t) => t.name)).toEqual(['mcp-brand-new-team']);
    const second = resolveTeams(['MCP-BRAND-NEW-TEAM']);
    expect(second.created).toEqual([]);
    expect(second.teams[0].id).toBe(first.teams[0].id);
  });

  test('finds an existing team by slug, rather than creating a second one', async () => {
    const id = crypto.randomUUID();
    const now = new Date();
    // Names unique to this file: the suite shares one database.
    await db.insert(teams).values({ id, name: 'MCP Audience Portal', slug: 'mcpportal', createdAt: now, updatedAt: now });
    const resolution = resolveTeams(['McpPortal']);
    expect(resolution.created).toEqual([]);
    expect(resolution.teams.map((t) => t.id)).toEqual([id]);
  });

  test('a name matching two teams case-insensitively is skipped, not guessed', async () => {
    const now = new Date();
    await db.insert(teams).values([
      { id: crypto.randomUUID(), name: 'McpTwin', slug: 'mcp-twin-a', createdAt: now, updatedAt: now },
      { id: crypto.randomUUID(), name: 'mcptwin', slug: 'mcp-twin-b', createdAt: now, updatedAt: now },
    ]);
    const resolution = resolveTeams(['MCPTWIN']);
    expect(resolution.teams).toEqual([]);
    expect(resolution.skipped[0].name).toBe('MCPTWIN');
  });
});

// ── The endpoint ─────────────────────────────────────────────────────────────

describe('/mcp', () => {
  let podpTeamId: string;
  let ownAppId: string;
  let foreignAppId: string;
  let foreignDeploymentId: string;

  async function call(body: unknown, token?: string | null, headers: Record<string, string> = {}) {
    const { POST } = await import('../../../routes/mcp/+server.ts');
    return POST({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    } as any);
  }

  async function tool(name: string, args: Record<string, unknown>, token?: string) {
    const response = await call(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      token ?? (await sign(accessClaims())),
    );
    expect(response.status).toBe(200);
    return (await response.json()).result as { isError?: boolean; structuredContent: any };
  }

  beforeAll(async () => {
    process.env.MCP_OIDC_ISSUER = ISSUER;
    process.env.PUBLIC_URL = 'https://rudder.example.test';
    setVerifierForTests(verifier());

    const now = new Date();
    podpTeamId = crypto.randomUUID();
    const foreignTeamId = crypto.randomUUID();
    await db.insert(teams).values([
      { id: podpTeamId, name: 'mcppodp', slug: 'mcppodp', createdAt: now, updatedAt: now },
      { id: foreignTeamId, name: 'MCP Somebody Else', slug: 'mcp-somebody-else', createdAt: now, updatedAt: now },
    ]);
    ownAppId = crypto.randomUUID();
    foreignAppId = crypto.randomUUID();
    await db.insert(applications).values([
      { id: ownAppId, name: 'portal-web', teamId: podpTeamId, manifest: 'image: nginx', createdAt: now, updatedAt: now },
      { id: foreignAppId, name: 'secret-app', teamId: foreignTeamId, manifest: 'image: nginx', createdAt: now, updatedAt: now },
    ]);
    foreignDeploymentId = crypto.randomUUID();
    await db.insert(deployments).values({
      id: foreignDeploymentId, applicationId: foreignAppId, version: 1, status: 'succeeded', createdAt: now,
    });
  });

  afterAll(() => {
    delete process.env.MCP_OIDC_ISSUER;
    setVerifierForTests(null);
  });

  beforeEach(() => clearTasksForTests());

  test('is off unless an issuer is configured', async () => {
    const saved = process.env.MCP_OIDC_ISSUER;
    delete process.env.MCP_OIDC_ISSUER;
    try {
      expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, await sign(accessClaims()))).status).toBe(404);
    } finally {
      process.env.MCP_OIDC_ISSUER = saved;
    }
  });

  test('challenges a request with no token, pointing at the resource metadata', async () => {
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://rudder.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('refuses an invalid token with invalid_token', async () => {
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, await sign(accessClaims(), { key: otherRsa.privateKey }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  test('refuses a valid token whose audience names no team', async () => {
    const response = await call(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      await sign(accessClaims({ aud: 'account' })),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
  });

  test('refuses a browser origin it does not know', async () => {
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, await sign(accessClaims()), {
      Origin: 'https://attacker.example.test',
    });
    expect(response.status).toBe(403);
  });

  test('initializes and lists only application tools', async () => {
    const init = await call(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      await sign(accessClaims()),
    );
    const initBody = await init.json();
    expect(initBody.result.protocolVersion).toBe('2025-06-18');
    expect(initBody.result.capabilities.tools).toBeDefined();

    const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, await sign(accessClaims()))).json();
    const names: string[] = list.result.tools.map((t: any) => t.name);
    expect(names).toContain('deploy_application');
    expect(names).toContain('get_task');
    expect(names.some((n) => /worker|user|secret|setting/i.test(n))).toBe(false);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  test('a notification is acknowledged with 202 and no body', async () => {
    const response = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, await sign(accessClaims()));
    expect(response.status).toBe(202);
  });

  test('lists the token team\'s applications and nobody else\'s', async () => {
    const result = await tool('list_applications', {});
    const names = result.structuredContent.applications.map((a: any) => a.name);
    expect(names).toContain('portal-web');
    expect(names).not.toContain('secret-app');
  });

  test('another team\'s application is "not found", by id and by name', async () => {
    for (const ref of [foreignAppId, 'secret-app']) {
      const result = await tool('get_application', { application: ref });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toContain('not found');
    }
    const deployment = await tool('get_deployment', { deploymentId: foreignDeploymentId });
    expect(deployment.isError).toBe(true);
  });

  test('cannot deploy another team\'s application, and nothing is recorded', async () => {
    const result = await tool('deploy_application', { application: foreignAppId });
    expect(result.isError).toBe(true);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, foreignAppId)).all();
    expect(audit).toEqual([]);
  });

  test('a deploy of an application with no worker is refused before a task starts', async () => {
    const result = await tool('deploy_application', { application: 'portal-web' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('no worker');
  });

  test('a new team in the audience is created on first use', async () => {
    const token = await sign(accessClaims({ aud: ['mcpfreshteam_abc123'] }));
    const result = await tool('list_teams', {}, token);
    expect(result.structuredContent.teams.map((t: any) => t.name)).toEqual(['mcpfreshteam']);
    expect(await db.select().from(teams).where(eq(teams.slug, 'mcpfreshteam')).get()).toBeTruthy();
  });

  test('scales only to 1–10 replicas', async () => {
    const result = await tool('scale_application', { application: 'portal-web', replicas: 50 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain('Invalid arguments');
  });

  test('get_task reports progress and hides other teams\' tasks', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const task = startTask(
      { kind: 'deploy', applicationId: ownAppId, applicationName: 'portal-web', teamId: podpTeamId, startedBy: 'x' },
      async () => {
        await gate;
        return { success: false, message: 'image pull failed' };
      },
    );

    const running = await tool('get_task', { taskId: task.id });
    expect(running.structuredContent.status).toBe('running');

    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(getTask(task.id)?.status).toBe('failed');
    const failed = await tool('get_task', { taskId: task.id });
    expect(failed.structuredContent.status).toBe('failed');
    expect(failed.structuredContent.message).toBe('image pull failed');

    // A token for a different team cannot see it.
    const other = await tool('get_task', { taskId: task.id }, await sign(accessClaims({ aud: ['mcphmi_zz'] })));
    expect(other.isError).toBe(true);
  });

  test('a second operation on an application with one running is refused', async () => {
    // Give the app a (fictional) worker so the worker check passes and the busy check is what answers.
    const { workers } = await import('$lib/db/schema');
    const workerId = crypto.randomUUID();
    await db.insert(workers).values({
      id: workerId, name: 'w', hostname: 'w.example.test', sshUser: 'root',
      podmanApiUrl: 'https://w.example.test', createdAt: new Date(),
    });
    await db.update(applications).set({ workerId }).where(eq(applications.id, ownAppId));
    try {
      startTask(
        { kind: 'deploy', applicationId: ownAppId, applicationName: 'portal-web', teamId: podpTeamId, startedBy: 'x' },
        () => new Promise(() => {}),
      );
      const result = await tool('control_application', { application: 'portal-web', action: 'restart' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toContain('already running');
    } finally {
      await db.update(applications).set({ workerId: null }).where(eq(applications.id, ownAppId));
    }
  });

  test('protected resource metadata names the identity provider', async () => {
    const { GET } = await import('../../../routes/.well-known/oauth-protected-resource/[...rest]/+server.ts');
    const response = await GET({ params: { rest: 'mcp' } } as any);
    expect(await response.json()).toMatchObject({
      resource: 'https://rudder.example.test/mcp',
      authorization_servers: [ISSUER],
    });
  });
});
