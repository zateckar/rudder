import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { AuthorizationError, requireTeam, requireUser, route } from '$lib/server/auth';
import { parseBody, schemas } from '$lib/server/validation';

/**
 * The team, and whether the caller may manage its membership.
 *
 * Admins count as owners here, which they did not before. `/api/teams/[id]`
 * next door already made that call, for a reason that applies identically to
 * membership: a team created by OIDC group sync has no owner row at all, so
 * without it nobody — operator included — could add or remove anyone from it.
 * Having an admin able to delete a team but not remove a member from it was not
 * a policy, it was two files written at different times.
 */
async function teamForMembership(event: { locals: App.Locals }, teamId: string) {
  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new AuthorizationError('Team not found', 404);

  const { teamRole } = await requireTeam(event, team.id);
  return { team, isOwner: teamRole === 'owner' };
}

export const POST: RequestHandler = route(async (event) => {
  const { team, isOwner } = await teamForMembership(event, event.params.id!);
  if (!isOwner) {
    return json({ error: 'Only owners can add members' }, { status: 403 });
  }

  // `schemas.addTeamMember` constrains `role` to the enum. SQLite does not
  // enforce the column's, so an arbitrary string was stored; every check in the
  // codebase is `=== 'owner'`, which made a junk role read as a non-owner and
  // kept it inert — but silently storing a role that means nothing is one
  // refactor away from meaning something.
  const body = await event.request.json();
  const { role: memberRole } = parseBody(
    { role: body.role ?? 'member' },
    schemas.addTeamMember.pick({ role: true }),
  );

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
    role: memberRole,
    joinedAt: new Date(),
  });

  return json({ success: true, message: 'Member added' });
});

export const DELETE: RequestHandler = route(async (event) => {
  const callerId = requireUser(event).user.id;

  const memberId = event.url.searchParams.get('memberId');
  if (!memberId) {
    return json({ error: 'Member ID required' }, { status: 400 });
  }

  const { team, isOwner } = await teamForMembership(event, event.params.id!);

  // Leaving a team you belong to needs no ownership; removing anyone else does.
  const isRemovingSelf = memberId === callerId;
  if (!isRemovingSelf && !isOwner) {
    return json({ error: 'Only owners can remove other members' }, { status: 403 });
  }

  const targetMembership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)))
    .get();

  if (!targetMembership) {
    return json({ error: 'Member not found' }, { status: 404 });
  }

  if (targetMembership.role === 'owner' && !isRemovingSelf) {
    return json({ error: 'Cannot remove owner' }, { status: 403 });
  }

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, memberId)));

  return json({ success: true, message: 'Member removed' });
});
