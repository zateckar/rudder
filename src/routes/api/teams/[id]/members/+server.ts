import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { AuthorizationError, requireAdminUser, route } from '$lib/server/auth';

/**
 * The team, for a caller allowed to manage who is in it.
 *
 * Admin-only. Membership used to be an owner's job, which meant a team created
 * by OIDC group sync — no owner row at all — had nobody who could add anyone to
 * it. It is now managed from `/users`, one screen per account rather than one per
 * team, and that screen is admin-only.
 */
async function teamForMembership(event: { locals: App.Locals }, teamId: string) {
  requireAdminUser(event);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new AuthorizationError('Team not found', 404);

  return team;
}

export const POST: RequestHandler = route(async (event) => {
  const team = await teamForMembership(event, event.params.id!);

  const body = await event.request.json();

  // `userId` or `email` — the schema cannot express "one of these two", so the
  // choice stays here where the fallback lookup is.
  let targetUserId: string | undefined = body.userId;
  const email: string | undefined = body.email;

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

  const existingMember = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetUserId)))
    .get();

  if (existingMember) {
    return json({ error: 'User is already a member' }, { status: 400 });
  }

  await db.insert(teamMembers).values({
    teamId: team.id,
    userId: targetUserId,
    joinedAt: new Date(),
  });

  return json({ success: true, message: 'Member added' });
});

export const DELETE: RequestHandler = route(async (event) => {
  const memberId = event.url.searchParams.get('memberId');
  if (!memberId) {
    return json({ error: 'Member ID required' }, { status: 400 });
  }

  const team = await teamForMembership(event, event.params.id!);

  const targetMembership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)))
    .get();

  if (!targetMembership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)));

  return json({ success: true, message: 'Member removed' });
});
