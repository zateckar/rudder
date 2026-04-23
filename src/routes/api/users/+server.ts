import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { hashPassword } from '$lib/auth';

export const GET: RequestHandler = async ({ cookies, url }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only admins can list users
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  const allUsers = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).all();

  return json(allUsers);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only admins can create users
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  const body = await request.json();
  const { username, email, password, fullName, role } = body;

  if (!username || !email || !fullName) {
    return json({ error: 'Username, email, and fullName are required' }, { status: 400 });
  }

  // Check for existing user
  const existingUser = await db.select().from(users)
    .where(eq(users.username, username))
    .get();
  
  if (existingUser) {
    return json({ error: 'Username already exists' }, { status: 409 });
  }

  const existingEmail = await db.select().from(users)
    .where(eq(users.email, email))
    .get();
  
  if (existingEmail) {
    return json({ error: 'Email already exists' }, { status: 409 });
  }

  const newUserId = uuid();
  const now = new Date();

  await db.insert(users).values({
    id: newUserId,
    username,
    email,
    passwordHash: password ? await hashPassword(password) : null,
    fullName,
    role: role === 'admin' ? 'admin' : 'member',
    createdAt: now,
    updatedAt: now,
  });

  const created = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, newUserId)).get();

  return json(created, { status: 201 });
};
