import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
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
    return json({ error: 'Only owners can add members' }, { status: 403 });
  }

  const body = await request.json();
  const { userId: newUserId, email, role } = body;

  let targetUserId = newUserId;

  if (!targetUserId && email) {
    const user = await db.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      return json({ error: 'User not found' }, { status: 404 });
    }
    targetUserId = user.id;
  }

  if (!targetUserId) {
    return json({ error: 'User ID or email required' }, { status: 400 });
  }

  const existingMember = await db.select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetUserId)))
    .get();

  if (existingMember) {
    return json({ error: 'User is already a member' }, { status: 400 });
  }

  await db.insert(teamMembers).values({
    teamId: team.id,
    userId: targetUserId,
    role: role || 'member',
    joinedAt: new Date(),
  });

  return json({ success: true, message: 'Member added' });
}

export async function DELETE({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
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

  const url = new URL(request.url);
  const memberId = url.searchParams.get('memberId');

  if (!memberId) {
    return json({ error: 'Member ID required' }, { status: 400 });
  }

  const isRemovingSelf = memberId === userId;
  const isOwner = membership?.role === 'owner';

  if (!isRemovingSelf && !isOwner) {
    return json({ error: 'Only owners can remove other members' }, { status: 403 });
  }

  const targetMembership = await db.select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)))
    .get();

  if (!targetMembership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  if (targetMembership.role === 'owner' && !isRemovingSelf) {
    return json({ error: 'Cannot remove owner' }, { status: 403 });
  }

  await db.delete(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)));

  return json({ success: true, message: 'Member removed' });
}
