import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, oidcConfig } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export const load = async ({ cookies, url }: { cookies: any; url: URL }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') throw redirect(303, '/dashboard');

  // Load generic OIDC config from DB (take first/only row)
  const config = await db.select().from(oidcConfig).get();

  // The callback URL that must be registered in the OIDC provider
  const publicUrl = url.origin;
  const callbackUrl = `${publicUrl}/api/auth/oidc/generic/callback`;

  return {
    user: currentUser,
    config: config ?? null,
    callbackUrl,
  };
};

export const actions = {
  save: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const currentUser = await db.select().from(users).where(eq(users.id, userId!)).get();
    if (!currentUser || currentUser.role !== 'admin') {
      return fail(403, { error: 'Forbidden' });
    }

    const formData = await request.formData();

    const data = {
      enabled: formData.get('enabled') === 'on',
      providerName: formData.get('providerName')?.toString() || 'Generic OIDC',
      issuerUrl: formData.get('issuerUrl')?.toString() || null,
      clientId: formData.get('clientId')?.toString() || null,
      clientSecret: formData.get('clientSecret')?.toString() || null,
      authorizationEndpoint: formData.get('authorizationEndpoint')?.toString() || null,
      tokenEndpoint: formData.get('tokenEndpoint')?.toString() || null,
      userinfoEndpoint: formData.get('userinfoEndpoint')?.toString() || null,
      jwksUri: formData.get('jwksUri')?.toString() || null,
      scopes: formData.get('scopes')?.toString() || 'openid email profile',
      usePkce: formData.get('usePkce') !== 'off',
      allowRegistration: formData.get('allowRegistration') !== 'off',
      teamClaimName: formData.get('teamClaimName')?.toString() || null,
      teamClaimKey: formData.get('teamClaimKey')?.toString() || null,
    };

    const now = new Date();
    const existing = await db.select().from(oidcConfig).get();

    if (existing) {
      await db.update(oidcConfig).set({ ...data, updatedAt: now }).where(eq(oidcConfig.id, existing.id));
    } else {
      await db.insert(oidcConfig).values({ id: uuid(), ...data, createdAt: now, updatedAt: now });
    }

    return { success: true };
  },

  discover: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const issuerUrl = formData.get('issuerUrl')?.toString();
    if (!issuerUrl) return fail(400, { error: 'Issuer URL required' });

    try {
      const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(discoveryUrl);
      if (!res.ok) {
        return fail(400, { error: `Discovery failed: ${res.status} ${res.statusText}` });
      }
      const meta = await res.json();
      return {
        discovered: {
          authorizationEndpoint: meta.authorization_endpoint ?? '',
          tokenEndpoint: meta.token_endpoint ?? '',
          userinfoEndpoint: meta.userinfo_endpoint ?? '',
          jwksUri: meta.jwks_uri ?? '',
        },
      };
    } catch (e: any) {
      return fail(400, { error: `Discovery error: ${e.message}` });
    }
  },
};
