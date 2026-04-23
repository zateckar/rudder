import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users, userOidc, teamMembers, teams } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  // Check API key auth first
  if (locals.userId) {
    const user = await db.select({
      id: users.id,
      username: users.username,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, locals.userId)).get();

    if (!user) {
      return json({ error: 'User not found' }, { status: 404 });
    }

    return json(user);
  }

  // Fall back to session auth
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, userId)).get();

  if (!user) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  // Get linked OIDC providers
  const oidcLinks = await db.select({
    provider: userOidc.provider,
    lastSyncedAt: userOidc.lastSyncedAt,
  }).from(userOidc).where(eq(userOidc.userId, userId)).all();

  // Get user's teams
  const userTeams = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
      teamSlug: teams.slug,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .all();

  return json({
    ...user,
    oidcProviders: oidcLinks.map(l => l.provider),
    teams: userTeams,
  });
};
