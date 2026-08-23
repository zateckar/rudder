import { db } from '$lib/db';
import { teamMembers } from '$lib/db/schema';
import { inArray, count } from 'drizzle-orm';
import { requirePageUser, userTeams } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  const user = requirePageUser(event).user;
  const teamList = await userTeams(event);

  if (teamList.length === 0) return { user, teams: [] };

  // One grouped count for every team, not a `SELECT count(*)` per team.
  const counts = await db
    .select({ teamId: teamMembers.teamId, n: count() })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, teamList.map((t) => t.id)))
    .groupBy(teamMembers.teamId)
    .all();
  const byTeam = new Map(counts.map((c) => [c.teamId, c.n]));

  return {
    user,
    teams: teamList.map((team) => ({ ...team, memberCount: byTeam.get(team.id) ?? 0 })),
  };
};
