import { hash, compare } from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, sessions } from '../db/schema';
import { env } from '../server/env';
import type { Cookies } from '@sveltejs/kit';

const SESSION_COOKIE_NAME = 'session_id';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return compare(password, hash);
}

export async function createSession(userId: string): Promise<string> {
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE * 1000);
  
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
    createdAt: new Date(),
  });
  
  return sessionId;
}

export async function validateSession(sessionId: string): Promise<string | null> {
  const result = await db.select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  
  if (!result) return null;
  
  if (result.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  
  return result.userId;
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function refreshSession(sessionId: string): Promise<boolean> {
  const result = await db.select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  
  if (!result) return false;
  
  const newExpiry = new Date(Date.now() + env.SESSION_MAX_AGE * 1000);
  
  await db.update(sessions)
    .set({ expiresAt: newExpiry })
    .where(eq(sessions.id, sessionId));
  
  return true;
}

export function getSessionIdFromCookies(cookies: Cookies): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME);
}

export function setSessionCookie(cookies: Cookies, sessionId: string): void {
  cookies.set(SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
