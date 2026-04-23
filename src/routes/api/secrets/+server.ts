import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { secrets, users, teams, teamMembers } from '$lib/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { encrypt, decrypt } from '$lib/server/encryption';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

export const GET: RequestHandler = async ({ cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  let rows;
  if (user.role === 'admin') {
    // Admins see all secrets
    rows = await db.select().from(secrets).all();
  } else {
    // Regular users see global secrets + secrets from their teams
    const memberships = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);

    if (teamIds.length > 0) {
      rows = await db.select().from(secrets)
        .where(or(
          eq(secrets.scope, 'global'),
          ...teamIds.map(tid => eq(secrets.teamId, tid))
        ))
        .all();
    } else {
      rows = await db.select().from(secrets).where(eq(secrets.scope, 'global')).all();
    }
  }

  // Decrypt values before returning
  const result = rows.map(s => ({
    ...s,
    value: (() => { try { return decrypt(s.value); } catch { return '[decryption error]'; } })(),
    createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt as any).toISOString(),
    updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : new Date(s.updatedAt as any).toISOString(),
  }));

  return json(result);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  let body;
  try {
    body = await parseJsonBody(request, schemas.createSecret);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { name, value, description, scope, teamId } = body;

  const finalScope = scope === 'global' ? 'global' : 'team';

  // Only admins can create global secrets
  if (finalScope === 'global' && user.role !== 'admin') {
    return json({ error: 'Only admins can create global secrets' }, { status: 403 });
  }

  // For team secrets, verify user is a member of the team
  if (finalScope === 'team' && teamId) {
    if (user.role !== 'admin') {
      const membership = await db.select().from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
        .get();
      if (!membership) return json({ error: 'Not a member of this team' }, { status: 403 });
    }
  }

  const now = new Date();
  const id = uuid();

  await db.insert(secrets).values({
    id,
    name,
    value: encrypt(value),
    description: description || null,
    scope: finalScope,
    teamId: finalScope === 'team' ? (teamId || null) : null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return json({ id, name, scope: finalScope, teamId: finalScope === 'team' ? teamId : null }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const body = await request.json();
  const { id, name, value, description } = body;
  if (!id) return json({ error: 'Secret ID required' }, { status: 400 });

  const existing = await db.select().from(secrets).where(eq(secrets.id, id)).get();
  if (!existing) return json({ error: 'Secret not found' }, { status: 404 });

  // Check permissions: admin can edit any, user can edit their team's
  if (user.role !== 'admin' && existing.createdBy !== userId) {
    return json({ error: 'Not authorized to edit this secret' }, { status: 403 });
  }

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (value !== undefined) updates.value = encrypt(value);
  if (description !== undefined) updates.description = description;

  await db.update(secrets).set(updates).where(eq(secrets.id, id));
  return json({ success: true });
};

export const DELETE: RequestHandler = async ({ url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Secret ID required' }, { status: 400 });

  const existing = await db.select().from(secrets).where(eq(secrets.id, id)).get();
  if (!existing) return json({ error: 'Secret not found' }, { status: 404 });

  if (user.role !== 'admin' && existing.createdBy !== userId) {
    return json({ error: 'Not authorized to delete this secret' }, { status: 403 });
  }

  await db.delete(secrets).where(eq(secrets.id, id));
  return json({ success: true });
};
