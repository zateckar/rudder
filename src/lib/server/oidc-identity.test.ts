import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { db } from '#lib/db/index.ts';
import { oidcConfig, sessions, userOidc, users } from '#lib/db/schema.ts';
import { validateSession } from '#lib/auth/index.ts';
import { GET as startLogin } from '../../routes/api/auth/oidc/generic/+server';
import { GET as completeLogin } from '../../routes/api/auth/oidc/generic/callback/+server';
import { eq } from 'drizzle-orm';
import { JwtVerifier } from './mcp/jwt';
import { migrateLegacyOidcAtStartup, migrateLegacyOidcLink, migrateLegacyOidcLinks, oidcProviderId } from './oidc-identity';

const issuer = 'https://idp.example.test/realms/panel';
const now = new Date('2026-11-26T12:00:00Z');

function signingKey() {
  return crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
}

async function signedToken(key: CryptoKey, claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${encode({ alg: 'RS256' })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signed));
  return `${signed}.${Buffer.from(signature).toString('base64url')}`;
}

test('browser login accepts an ID token bound to its issuer, client, and nonce', async () => {
  const key = await signingKey();
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const verifier = new JwtVerifier({
    issuer,
    jwksUri: `${issuer}/keys`,
    fetch: async () => Response.json({ keys: [jwk] }),
    now: () => now.getTime(),
  });
  const token = await signedToken(key.privateKey, {
    iss: issuer, sub: 'member-123', aud: 'rudder', nonce: 'login-nonce',
    iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 300, typ: 'ID',
  });

  expect((await verifier.verifyIdToken(token, 'rudder', 'login-nonce')).sub).toBe('member-123');
  await expect(verifier.verifyIdToken(token, 'another-client', 'login-nonce')).rejects.toThrow('for this client');
  await expect(verifier.verifyIdToken(token, 'rudder', 'other-nonce')).rejects.toThrow('Invalid ID token claims');
  await expect(verifier.verify(token)).rejects.toThrow('not an access token');
});

test('generic login only issues a session for the configured issuer and matching UserInfo subject', async () => {
  const configId = crypto.randomUUID();
  const email = `${configId}@example.test`;
  const provider = `https://${configId}.example.test`;
  const key = await signingKey();
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const providerConfig = (currentIssuer: string) => ({
    issuerUrl: currentIssuer,
    authorizationEndpoint: `${currentIssuer}/authorize`,
    tokenEndpoint: `${currentIssuer}/token`,
    userinfoEndpoint: `${currentIssuer}/userinfo`,
    jwksUri: `${currentIssuer}/keys`,
  });
  db.insert(oidcConfig).values({
    id: configId, enabled: true, clientId: 'rudder', ...providerConfig(provider), createdAt: now, updatedAt: now,
  }).run();

  let token: string;
  let userInfoSubject = 'other-member';
  const fetchStub = async (input: Parameters<typeof fetch>[0]) => {
    const endpoint = new URL(String(input)).pathname.split('/').at(-1);
    if (endpoint === 'token') return Response.json({ id_token: token, access_token: 'provider-access-token' });
    if (endpoint === 'userinfo') return Response.json({ sub: userInfoSubject, email, email_verified: true });
    if (endpoint === 'keys') return Response.json({ keys: [jwk] });
    throw new Error('Unexpected provider request');
  };
  const providerFetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(fetchStub, { preconnect: fetch.preconnect }),
  );
  try {
    for (const [currentIssuer, expectedRedirect] of [
      [provider, '/login?error=oidc_userinfo_error'],
      [provider, '/dashboard'],
      [`${provider}/new-issuer`, '/login?error=oidc_account_linked'],
    ]) {
      db.update(oidcConfig).set(providerConfig(currentIssuer)).where(eq(oidcConfig.id, configId)).run();
      const cookies = new Map<string, string>();
      const url = new URL('https://rudder.example.test/api/auth/oidc/generic');
      await expect(startLogin({ url, cookies })).rejects.toMatchObject({ status: 302 });
      const issuedAt = Math.floor(Date.now() / 1000);
      token = await signedToken(key.privateKey, {
        iss: currentIssuer, sub: 'member-123', aud: 'rudder', nonce: cookies.get('oidc_nonce'),
        iat: issuedAt, exp: issuedAt + 300,
      });
      url.pathname += '/callback';
      url.searchParams.set('code', 'authorization-code');
      url.searchParams.set('state', cookies.get('oidc_state')!);
      await expect(completeLogin({ url, cookies })).rejects.toMatchObject({ location: expectedRedirect });
      if (expectedRedirect === '/dashboard') {
        const localUser = db.select().from(users).where(eq(users.email, email)).get();
        expect(typeof cookies.get('session_id')).toBe('string');
        expect(await validateSession(cookies.get('session_id')!)).toBe(localUser!.id);
      } else {
        expect(cookies.has('session_id')).toBe(false);
      }
      userInfoSubject = 'member-123';
    }
  } finally {
    providerFetch.mockRestore();
    db.delete(oidcConfig).where(eq(oidcConfig.id, configId)).run();
    const localUser = db.select().from(users).where(eq(users.email, email)).get();
    if (localUser) {
      db.delete(sessions).where(eq(sessions.userId, localUser.id)).run();
      db.delete(userOidc).where(eq(userOidc.userId, localUser.id)).run();
      db.delete(users).where(eq(users.id, localUser.id)).run();
    }
  }
});

describe('legacy OIDC links', () => {
  const ids: { userId: string; linkId: string }[] = [];

  afterEach(() => {
    for (const { userId, linkId } of ids.splice(0)) {
      db.delete(userOidc).where(eq(userOidc.id, linkId)).run();
      db.delete(users).where(eq(users.id, userId)).run();
    }
  });

  function legacyLink(legacySubject: string) {
    const userId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    ids.push({ userId, linkId });
    db.insert(users).values({
      id: userId, username: userId, email: `${userId}@example.test`,
      fullName: 'Local user', role: 'member', createdAt: now, updatedAt: now,
    }).run();
    db.insert(userOidc).values({ id: linkId, userId, provider: 'auth0', providerId: `generic:${legacySubject}` }).run();
    return linkId;
  }

  test('issuer migration preserves ownership and leaves ambiguous subjects for an administrator', () => {
    const original = legacyLink('member-123');
    const ambiguous = legacyLink('old-email@example.test');
    const currentKey = (id: string) => db.select().from(userOidc).where(eq(userOidc.id, id)).get()?.providerId;
    const originalOwner = db.select().from(userOidc).where(eq(userOidc.id, original)).get()?.userId;

    expect(migrateLegacyOidcLinks(issuer)).toEqual({ migrated: 1, needsReview: 1 });
    expect(currentKey(original)).toBe(oidcProviderId(issuer, 'member-123'));
    expect(db.select().from(userOidc).where(eq(userOidc.id, original)).get()?.userId).toBe(originalOwner);
    expect(currentKey(original)).not.toBe(oidcProviderId('https://another.example.test', 'member-123'));
    expect(currentKey(ambiguous)).toBe('generic:old-email@example.test');
    expect(migrateLegacyOidcLink(ambiguous, issuer, 'member-123')).toBe(false);
    expect(migrateLegacyOidcLink(ambiguous, issuer, 'member-456')).toBe(true);
    expect(currentKey(ambiguous)).toBe(oidcProviderId(issuer, 'member-456'));
  });

  test('startup migration requires an explicit match with the saved issuer', () => {
    const id = legacyLink('member-123');
    const configId = crypto.randomUUID();
    db.insert(oidcConfig).values({ id: configId, issuerUrl: issuer, createdAt: now, updatedAt: now }).run();
    const currentKey = () => db.select().from(userOidc).where(eq(userOidc.id, id)).get()?.providerId;
    try {
      expect(() => migrateLegacyOidcAtStartup('https://another.example.test')).toThrow('must exactly match');
      expect(currentKey()).toBe('generic:member-123');
      expect(migrateLegacyOidcAtStartup(issuer)).toEqual({ migrated: 1, needsReview: 0 });
      expect(currentKey()).toBe(oidcProviderId(issuer, 'member-123'));
      expect(migrateLegacyOidcAtStartup(issuer)).toEqual({ migrated: 0, needsReview: 0 });
    } finally {
      db.delete(oidcConfig).where(eq(oidcConfig.id, configId)).run();
    }
  });
});
