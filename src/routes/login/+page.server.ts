import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { users, oidcConfig } from '$lib/db/schema';
import { verifyPassword, createSession, setSessionCookie } from '$lib/auth';
import { getEnabledProviders } from '$lib/auth/oidc';

export const load = async ({ url }: { url: URL }) => {
  const enabledProviders = getEnabledProviders();

  // Check if generic OIDC is enabled in DB
  const genericOidc = await db.select({
    enabled: oidcConfig.enabled,
    providerName: oidcConfig.providerName,
  }).from(oidcConfig).get();

  return {
    error: url.searchParams.get('error'),
    oidcProviders: enabledProviders,
    genericOidc: (genericOidc?.enabled) ? { providerName: genericOidc.providerName } : null,
  };
};

export const actions = {
  default: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const formData = await request.formData();
    const username = formData.get('username')?.toString();
    const password = formData.get('password')?.toString();

    if (!username || !password) {
      return fail(400, { error: 'Username and password are required' });
    }

    const user = await db.select()
      .from(users)
      .where(eq(users.username, username))
      .get();

    if (!user || !user.passwordHash) {
      return fail(401, { error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return fail(401, { error: 'Invalid credentials' });
    }

    const sessionId = await createSession(user.id);
    setSessionCookie(cookies, sessionId);

    throw redirect(303, '/dashboard');
  }
};
