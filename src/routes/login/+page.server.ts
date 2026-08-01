import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { users, oidcConfig, auditLogs } from '$lib/db/schema';
import { verifyPassword, createSession, setSessionCookie } from '$lib/auth';
import { consume, reset } from '$lib/server/rate-limit';

/** Attempts allowed per identity and per source address before lockout. */
const PER_USER = { limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };
const PER_IP = { limit: 20, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };

/** A dummy hash so failed lookups cost the same as real ones. */
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEe.9d5xqQ0.a9jZ9Yq.tXHKtqQ0gv0zqSC';

async function recordFailedLogin(username: string, ip: string) {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: null,
      teamId: null,
      action: 'LOGIN_FAILED',
      resourceType: 'auth',
      resourceId: null,
      details: JSON.stringify({ username, ip }),
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('Failed to write login audit log:', e);
  }
}

export const load = async ({ url }: { url: URL }) => {
  // Check if generic OIDC is enabled in DB
  const genericOidc = await db.select({
    enabled: oidcConfig.enabled,
    providerName: oidcConfig.providerName,
  }).from(oidcConfig).get();

  return {
    error: url.searchParams.get('error'),
    genericOidc: (genericOidc?.enabled) ? { providerName: genericOidc.providerName } : null,
  };
};

export const actions = {
  default: async ({ request, cookies, getClientAddress }: {
    request: Request;
    cookies: any;
    getClientAddress: () => string;
  }) => {
    const formData = await request.formData();
    const username = formData.get('username')?.toString();
    const password = formData.get('password')?.toString();

    if (!username || !password) {
      return fail(400, { error: 'Username and password are required' });
    }

    const ip = getClientAddress();

    // Throttle before touching bcrypt so a flood costs the server nothing.
    const ipLimit = consume(`login:ip:${ip}`, PER_IP);
    const userLimit = consume(`login:user:${username.toLowerCase()}`, PER_USER);

    if (!ipLimit.allowed || !userLimit.allowed) {
      const retry = Math.max(ipLimit.retryAfterSeconds, userLimit.retryAfterSeconds);
      await recordFailedLogin(username, ip);
      return fail(429, {
        error: `Too many login attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`,
      });
    }

    const user = await db.select()
      .from(users)
      .where(eq(users.username, username))
      .get();

    // Always run a verification, even for unknown users: skipping it made the
    // response measurably faster and turned this into a username oracle.
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !user.passwordHash || !valid) {
      await recordFailedLogin(username, ip);
      return fail(401, { error: 'Invalid credentials' });
    }

    reset(`login:user:${username.toLowerCase()}`);

    const sessionId = await createSession(user.id);
    setSessionCookie(cookies, sessionId);

    throw redirect(303, '/dashboard');
  }
};
