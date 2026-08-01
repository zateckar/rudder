import { eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { users, sessions } from '../db/schema';
import { env } from '../server/env';
import { hashKey } from '../server/encryption';
import type { Cookies } from '@sveltejs/kit';

const SESSION_COOKIE_NAME = 'session_id';

/**
 * Sessions are stored by hash.  The raw token only ever lives in the user's
 * cookie, so read access to the database no longer hands over live sessions.
 */
function sessionKey(sessionId: string): string {
  return hashKey(sessionId);
}

/** Delete expired rows periodically; they were previously never collected. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanup = 0;

async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  } catch (e) {
    console.error('[auth] Failed to purge expired sessions:', e);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

export async function createSession(userId: string): Promise<string> {
  // 256 bits from the CSPRNG, rather than a UUIDv4's 122.
  const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE * 1000);

  await db.insert(sessions).values({
    id: sessionKey(sessionId),
    userId,
    expiresAt,
    createdAt: new Date(),
  });

  void cleanupExpiredSessions();

  return sessionId;
}

export async function validateSession(sessionId: string): Promise<string | null> {
  const key = sessionKey(sessionId);

  const result = await db.select()
    .from(sessions)
    .where(eq(sessions.id, key))
    .get();

  if (!result) return null;

  if (result.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, key));
    return null;
  }

  return result.userId;
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionKey(sessionId)));
}

export async function refreshSession(sessionId: string): Promise<boolean> {
  const key = sessionKey(sessionId);

  const result = await db.select()
    .from(sessions)
    .where(eq(sessions.id, key))
    .get();

  if (!result) return false;

  const newExpiry = new Date(Date.now() + env.SESSION_MAX_AGE * 1000);

  await db.update(sessions)
    .set({ expiresAt: newExpiry })
    .where(eq(sessions.id, key));

  return true;
}

export function getSessionIdFromCookies(cookies: Cookies): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME);
}

export function setSessionCookie(cookies: Cookies, sessionId: string): void {
  // Do not hard-code `secure` here — SvelteKit derives it from event.url.protocol,
  // which the node adapter sets correctly when PROTOCOL_HEADER=X-Forwarded-Proto
  // is present (baked into the Docker image).  This way it is always true behind
  // an HTTPS reverse proxy and false during plain-HTTP local development.
  cookies.set(SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: env.SESSION_MAX_AGE,
  });
}

export function deleteSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

export async function getUserFromSession(cookies: Cookies): Promise<typeof users.$inferSelect | null> {
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) return null;
  
  const userId = await validateSession(sessionId);
  if (!userId) return null;
  
  const user = await db.select()
    .from(users)
    .where(eq(users.id, userId))
    .get();
  
  return user || null;
}
