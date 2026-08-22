import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users, sessions, teamMembers, userOidc } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, validatePassword } from '$lib/auth';
import { parseJsonBody, schemas, ValidationError } from '$lib/server/validation';
import { z } from 'zod';

/**
 * What PATCH accepts.
 *
 * Built on the shared `userUpdate` schema so `fullName`, `email` and `role` are
 * constrained the same way everywhere, and extended with the two fields only
 * this route takes. `password` has to be declared even though
 * `validatePassword` is what checks it: zod strips unknown keys, so an
 * undeclared field would be silently dropped and the password never changed.
 *
 * Which of these the caller is actually allowed to set is decided below —
 * this is the shape, not the permission.
 */
const patchUserSchema = schemas.userUpdate.extend({
  username: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens')
    .optional(),
  password: z.string().optional(),
});

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

  // Validated rather than copied through. `role` in particular reaches every
  // authorization check in the codebase, all of which test `role === 'admin'`,
  // so an unconstrained string does not error — it silently demotes the user.
  let body: z.infer<typeof patchUserSchema>;
  try {
    body = await parseJsonBody(request, patchUserSchema);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const updates: Record<string, any> = { updatedAt: new Date() };

  // Fields users can update on their own profile
  const selfFields = ['fullName', 'email'] as const;
  // Additional fields admins can update
  const adminFields = ['username', 'role'] as const;

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
  let passwordChanged = false;
  if (body.password !== undefined && (isSelf || isAdmin)) {
    const passwordError = validatePassword(body.password);
    if (passwordError) {
      return json({ error: passwordError }, { status: 400 });
    }
    updates.passwordHash = await hashPassword(body.password);
    passwordChanged = true;
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

  // A password change has to evict the sessions minted under the old one, or
  // resetting a compromised account's password leaves the attacker signed in
  // until the session expires on its own — a week, by default. The caller's own
  // session goes too when they changed their own password; re-authenticating is
  // the correct outcome and the alternative is a carve-out that has to be right.
  if (passwordChanged) {
    try {
      await db.delete(sessions).where(eq(sessions.userId, params.id));
    } catch (e) {
      console.error('Failed to revoke sessions after password change:', e);
    }
  }

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
