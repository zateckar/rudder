import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users, userOidc, teamMembers, teams } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser, route } from '$lib/server/auth';

/**
 * GET /api/auth/me — who the caller is.
 *
 * Both branches this used to have — "API key auth first" via `locals.userId`,
 * then a session fallback that re-read the cookie — resolved the same user by
 * the same id. `locals.auth` is now that one answer, set by the hook for either
 * mechanism, so the second lookup is gone along with the second code path that
 * returned a different shape (no teams, no OIDC links) depending on how the
 * caller had authenticated.
 */
export const GET: RequestHandler = route(async (event) => {
  const { user: authUser } = requireUser(event);

  const user = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, authUser.id))
    .get();

  if (!user) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  const oidcLinks = await db
    .select({ provider: userOidc.provider, lastSyncedAt: userOidc.lastSyncedAt })
    .from(userOidc)
    .where(eq(userOidc.userId, user.id))
    .all();

  const userTeams = await db
    .select({
      teamId: teamMembers.teamId,
      teamName: teams.name,
      teamSlug: teams.slug,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, user.id))
    .all();

  return json({
    ...user,
    oidcProviders: oidcLinks.map((l) => l.provider),
    teams: userTeams,
  });
});
