import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes, users, teamMembers } from '$lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export const GET: RequestHandler = async ({ cookies, url }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  
  // Get user's teams
  const userTeams = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const teamIds = userTeams.map(t => t.teamId);

  // Filter by team if specified
  const teamId = url.searchParams.get('teamId');
  
  let allVolumes;
  if (user?.role === 'admin') {
    // Admin sees all volumes
    allVolumes = teamId 
      ? await db.select().from(volumes).where(eq(volumes.teamId, teamId)).all()
      : await db.select().from(volumes).all();
  } else {
    // Regular users see only their team's volumes
    if (teamId) {
      if (!teamIds.includes(teamId)) {
        return json({ error: 'Access denied to this team' }, { status: 403 });
      }
      allVolumes = await db.select().from(volumes).where(eq(volumes.teamId, teamId)).all();
    } else {
      allVolumes = await db.select().from(volumes).all();
      allVolumes = allVolumes.filter(v => v.teamId && teamIds.includes(v.teamId));
    }
  }

  return json(allVolumes);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { name, teamId, workerId, containerPath, sizeLimit } = body;

  if (!name || !containerPath) {
    return json({ error: 'Name and containerPath are required' }, { status: 400 });
  }

  // Verify user has access to the team
  if (teamId) {
    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    if (user?.role !== 'admin') {
      const { and } = await import('drizzle-orm');
      const membership = await db.select().from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
        .get();
      
      if (!membership) {
        return json({ error: 'Access denied to this team' }, { status: 403 });
      }
    }
  }

  const volumeId = uuid();
  const now = new Date();

  await db.insert(volumes).values({
    id: volumeId,
    name,
    teamId: teamId || null,
    workerId: workerId || null,
    containerPath,
    sizeLimit: sizeLimit || null,
    createdAt: now,
    updatedAt: now,
  });

  const created = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  return json(created, { status: 201 });
};
