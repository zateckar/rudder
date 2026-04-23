import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes, users, teamMembers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const volume = await db.select().from(volumes).where(eq(volumes.id, params.id)).get();
  
  if (!volume) {
    return json({ error: 'Volume not found' }, { status: 404 });
  }

  // Check access
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role !== 'admin' && volume.teamId) {
    const membership = await db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, userId)))
      .get();
    
    if (!membership) {
      return json({ error: 'Access denied' }, { status: 403 });
    }
  }

  return json(volume);
};

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const volume = await db.select().from(volumes).where(eq(volumes.id, params.id)).get();
  
  if (!volume) {
    return json({ error: 'Volume not found' }, { status: 404 });
  }

  // Check access
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role !== 'admin' && volume.teamId) {
    const membership = await db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, userId)))
      .get();
    
    if (!membership || membership.role !== 'owner') {
      return json({ error: 'Access denied - owner role required' }, { status: 403 });
    }
  }

  const body = await request.json();
  const allowedFields = ['name', 'containerPath', 'sizeLimit', 'workerId'];
  const updates: Record<string, any> = { updatedAt: new Date() };

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  await db.update(volumes).set(updates).where(eq(volumes.id, params.id));

  const updated = await db.select().from(volumes).where(eq(volumes.id, params.id)).get();
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const volume = await db.select().from(volumes).where(eq(volumes.id, params.id)).get();
  
  if (!volume) {
    return json({ error: 'Volume not found' }, { status: 404 });
  }

  // Check access
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role !== 'admin' && volume.teamId) {
    const membership = await db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, userId)))
      .get();
    
    if (!membership || membership.role !== 'owner') {
      return json({ error: 'Access denied - owner role required' }, { status: 403 });
    }
  }

  await db.delete(volumes).where(eq(volumes.id, params.id));
  
  return json({ success: true, message: 'Volume deleted' });
};
