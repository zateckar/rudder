import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, teams, teamMembers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser) throw redirect(303, '/login');

  let userTeams;
  if (currentUser.role === 'admin') {
    userTeams = await db.select().from(teams).all();
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);
    userTeams = teamIds.length > 0
      ? await db.select().from(teams).where(inArray(teams.id, teamIds)).all()
      : [];
  }

  return {
    user: currentUser,
    teams: userTeams,
  };
};
