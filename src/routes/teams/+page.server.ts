import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, sql } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  let teamList;

  if (currentUser?.role === 'admin') {
    // Admins see all teams
    teamList = await db.select().from(teams).all();
  } else {
    // Members see only their teams
    const memberships = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    const teamIds = memberships.map((m) => m.teamId);
    teamList =
      teamIds.length > 0
        ? await db
            .select()
            .from(teams)
            .where(sql`${teams.id} IN (${sql.join(teamIds.map(id => sql`${id}`), sql`, `)})`)
            .all()
        : [];
  }

  // Attach member counts
  const teamsWithCounts = await Promise.all(
    teamList.map(async (team) => {
      const count = await db
        .select({ count: sql<number>`count(*)` })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, team.id))
        .get();
      return { ...team, memberCount: count?.count ?? 0 };
    })
  );

  return {
    user: currentUser,
    teams: teamsWithCounts,
  };
};
