import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  
  if (!team) {
    return json({ error: 'Team not found' }, { status: 404 });
  }

  const membership = await db.select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
    .get();

  if (!membership) {
    return json({ error: 'Access denied' }, { status: 403 });
  }

  const members = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: teamMembers.role,
    joinedAt: teamMembers.joinedAt,
  })
    .from(teamMembers)
    .leftJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, team.id))
    .all();

  return json({
    ...team,
    members: members.filter(m => m.username),
    userRole: membership.role,
  });
}

export async function PATCH({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  
  if (!team) {
    return json({ error: 'Team not found' }, { status: 404 });
  }

  const membership = await db.select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
    .get();

  if (!membership || membership.role !== 'owner') {
    return json({ error: 'Only owners can update team settings' }, { status: 403 });
  }

  const body = await request.json();
  const { name } = body;

  const updates: any = { updatedAt: new Date() };
  
  if (name) {
    updates.name = name;
  }

  await db.update(teams).set(updates).where(eq(teams.id, params.id));

  return json({ success: true });
}

export async function DELETE({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  
  if (!team) {
    return json({ error: 'Team not found' }, { status: 404 });
  }

  const membership = await db.select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
    .get();

  if (!membership || membership.role !== 'owner') {
    return json({ error: 'Only owners can delete team' }, { status: 403 });
  }

  await db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
  await db.delete(teams).where(eq(teams.id, team.id));

  return json({ success: true });
}
