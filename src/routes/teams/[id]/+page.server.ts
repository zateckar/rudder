import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) {
    throw redirect(303, '/login');
  }
  
  const userId = await validateSession(sessionId);
  if (!userId) {
    throw redirect(303, '/login');
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  
  if (!team) {
    throw redirect(303, '/teams');
  }

  let userRole = 'member';
  
  if (currentUser?.role !== 'admin') {
    const membership = await db.select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
      .get();

    if (!membership) {
      throw redirect(303, '/teams');
    }
    
    userRole = membership.role;
  } else {
    userRole = 'owner'; // Admins have owner privileges on all teams
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

  return {
    user: currentUser,
    team,
    members: members.filter(m => m.username),
    userRole,
  };
};
