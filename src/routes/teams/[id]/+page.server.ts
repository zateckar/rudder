import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users, apiKeys } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requirePageUser } from '$lib/server/auth';

export const load = async (event: { params: { id: string }; locals: App.Locals }) => {
  const currentUser = requirePageUser(event).user;

  const team = await db.select().from(teams).where(eq(teams.id, event.params.id)).get();
  if (!team) throw redirect(303, '/teams');

  let userRole = 'member';

  if (currentUser.role !== 'admin') {
    const membership = await db.select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, currentUser.id)))
      .get();

    if (!membership) throw redirect(303, '/teams');

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

  // Load API keys for this team (team-scoped + global keys for admins)
  const teamApiKeys = await db.select()
    .from(apiKeys)
    .where(eq(apiKeys.teamId, team.id))
    .all();

  return {
    user: currentUser,
    team,
    members: members.filter(m => m.username),
    userRole,
    apiKeys: teamApiKeys,
  };
};
