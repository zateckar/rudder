import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users, sessions, teamMembers, userOidc } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword } from '$lib/auth';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Users can view their own profile, admins can view any
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (params.id !== userId && currentUser.role !== 'admin') {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  const user = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, params.id)).get();

  if (!user) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  // Get linked OIDC providers
  const oidcLinks = await db.select({
    provider: userOidc.provider,
    lastSyncedAt: userOidc.lastSyncedAt,
  }).from(userOidc).where(eq(userOidc.userId, params.id)).all();

  return json({ ...user, oidcProviders: oidcLinks });
};

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Users can update their own profile, admins can update any
  const isAdmin = currentUser.role === 'admin';
  const isSelf = params.id === userId;

  if (!isSelf && !isAdmin) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  const targetUser = await db.select().from(users).where(eq(users.id, params.id)).get();
  if (!targetUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  const body = await request.json();
  const updates: Record<string, any> = { updatedAt: new Date() };

  // Fields users can update on their own profile
  const selfFields = ['fullName', 'email'];
  // Additional fields admins can update
  const adminFields = ['username', 'role'];

  for (const field of selfFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (isAdmin) {
    for (const field of adminFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }
  }

  // Password update
  if (body.password && (isSelf || isAdmin)) {
    updates.passwordHash = await hashPassword(body.password);
  }

  // Check email uniqueness
  if (updates.email && updates.email !== targetUser.email) {
    const existing = await db.select().from(users).where(eq(users.email, updates.email)).get();
    if (existing) {
      return json({ error: 'Email already in use' }, { status: 409 });
    }
  }

  // Check username uniqueness
  if (updates.username && updates.username !== targetUser.username) {
    const existing = await db.select().from(users).where(eq(users.username, updates.username)).get();
    if (existing) {
      return json({ error: 'Username already in use' }, { status: 409 });
    }
  }

  await db.update(users).set(updates).where(eq(users.id, params.id));

  const updated = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, params.id)).get();

  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only admins can delete users
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  // Cannot delete yourself
  if (params.id === userId) {
    return json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  const targetUser = await db.select().from(users).where(eq(users.id, params.id)).get();
  if (!targetUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  // Delete related records
  await db.delete(sessions).where(eq(sessions.userId, params.id));
  await db.delete(teamMembers).where(eq(teamMembers.userId, params.id));
  await db.delete(userOidc).where(eq(userOidc.userId, params.id));
  await db.delete(users).where(eq(users.id, params.id));

  return json({ success: true, message: 'User deleted' });
};
