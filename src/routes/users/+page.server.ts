import { db } from '$lib/db';
import { teamMembers, teams, userOidc, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageAdmin(event).user;

  // `passwordHash` is selected and then thrown away: whether an account can sign
  // in with a password is what distinguishes a local account from one that exists
  // only because an IdP vouched for it, and it is not derivable from anything
  // else. Only the boolean leaves this function.
  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .all();

  // Three list queries rather than one per user: this page is small, but it grew
  // a row per account and a join per row would make it quadratic in the account
  // count for no reason.
  const oidcLinks = await db
    .select({ userId: userOidc.userId, provider: userOidc.provider, lastSyncedAt: userOidc.lastSyncedAt })
    .from(userOidc)
    .all();

  const memberships = await db
    .select({
      userId: teamMembers.userId,
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .all();

  const linkByUser = new Map(oidcLinks.map((l) => [l.userId, l]));
  const teamsByUser = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const list = teamsByUser.get(m.userId);
    if (list) list.push(m);
    else teamsByUser.set(m.userId, [m]);
  }

  // Every team, because membership is managed from here now: the picker has to
  // offer teams the user is not yet in, which is the complement of what the rows
  // above carry.
  const allTeams = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .all();
  allTeams.sort((a, b) => a.name.localeCompare(b.name));

  return {
    user: currentUser,
    teams: allTeams,
    usersList: allUsers.map(({ passwordHash, ...u }) => {
      const link = linkByUser.get(u.id);
      return {
        ...u,
        // Not exclusive: an account created locally and later linked to the IdP
        // is both, and showing only one of the two would misrepresent how it can
        // be signed into.
        isLocal: !!passwordHash,
        isOidc: !!link,
        lastSyncedAt: link?.lastSyncedAt ?? null,
        teams: (teamsByUser.get(u.id) ?? []).sort((a, b) => a.teamName.localeCompare(b.teamName)),
      };
    }),
  };
};
