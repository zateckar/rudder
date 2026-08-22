import { json } from '@sveltejs/kit';
import { db, sqlite } from '$lib/db';
import { teams, teamMembers, users, applications, stacks } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Resolve the caller's authority over a team.
 *
 * Admins are treated as owners, the way `requireTeamMember` in
 * `$lib/server/auth` already does everywhere else. Without that, a team with no
 * owner row — every team created by OIDC group sync — could not be renamed or
 * removed by anyone at all, including an operator.
 */
async function teamAuthority(
  cookies: any,
  teamId: string,
): Promise<
  | { ok: false; response: Response }
  | { ok: true; team: typeof teams.$inferSelect; isOwner: boolean }
> {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return { ok: false, response: json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) {
    return { ok: false, response: json({ error: 'Team not found' }, { status: 404 }) };
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role === 'admin') {
    return { ok: true, team, isOwner: true };
  }

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
    .get();

  if (!membership) {
    return { ok: false, response: json({ error: 'Access denied' }, { status: 403 }) };
  }

  return { ok: true, team, isOwner: membership.role === 'owner' };
}

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const auth = await teamAuthority(cookies, params.id);
  if (!auth.ok) return auth.response;
  const team = auth.team;

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

  return json({
    ...team,
    members: members.filter(m => m.username),
    userRole: auth.isOwner ? 'owner' : 'member',
  });
}

export async function PATCH({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const auth = await teamAuthority(cookies, params.id);
  if (!auth.ok) return auth.response;
  if (!auth.isOwner) {
    return json({ error: 'Only owners can update team settings' }, { status: 403 });
  }

  const body = await request.json();
  const { name } = body;

  const updates: any = { updatedAt: new Date() };
  
  if (name) {
    updates.name = name;
  }

  await db.update(teams).set(updates).where(eq(teams.id, params.id));

  return json({ success: true });
}

/**
 * Delete a team and everything that only exists because the team did.
 *
 * Eleven tables reference `teams.id` and not one of them declares
 * `ON DELETE CASCADE`, while `PRAGMA foreign_keys = ON` is set in
 * `src/lib/db/index.ts`. The two-statement version this replaces dropped the
 * memberships and then tried to drop the team, so deleting a team that owned
 * anything at all failed on the foreign key — after its members were already
 * gone, leaving a team nobody could reach or finish deleting.
 *
 * Applications and stacks are deliberately *not* removed. They are running
 * infrastructure with containers behind them, and destroying it as a side effect
 * of tidying up a team is not this endpoint's decision to make; the caller is
 * told to move or delete them first.
 *
 * Audit rows are unlinked rather than deleted. They are the record of what was
 * done to the team, which is precisely what you still want once it is gone.
 */
export async function DELETE({ params, cookies }: { params: { id: string }; cookies: any }) {
  const auth = await teamAuthority(cookies, params.id);
  if (!auth.ok) return auth.response;
  if (!auth.isOwner) {
    return json({ error: 'Only owners can delete team' }, { status: 403 });
  }
  const team = auth.team;

  const ownedApps = await db
    .select({ id: applications.id, name: applications.name })
    .from(applications)
    .where(eq(applications.teamId, team.id))
    .all();
  const ownedStacks = await db
    .select({ id: stacks.id, name: stacks.name })
    .from(stacks)
    .where(eq(stacks.teamId, team.id))
    .all();

  if (ownedApps.length > 0 || ownedStacks.length > 0) {
    const blockers = [
      ...ownedApps.map((a) => `application "${a.name}"`),
      ...ownedStacks.map((s) => `stack "${s.name}"`),
    ];
    return json(
      {
        error:
          `Team "${team.name}" still owns ${blockers.slice(0, 5).join(', ')}` +
          (blockers.length > 5 ? ` and ${blockers.length - 5} more` : '') +
          `. Move them to another team or delete them first — deleting the team ` +
          `will not tear down running containers for you.`,
      },
      { status: 409 },
    );
  }

  // One transaction: a failure partway through used to leave the team stripped
  // of its members but still present.
  try {
    sqlite.transaction((id: string) => {
      // Alert rules in *other* teams may point at a channel this team owns, so
      // the reference has to go before the channel can.
      sqlite.run(
        `UPDATE alert_rules SET channel_id = NULL
           WHERE channel_id IN (SELECT id FROM notification_channels WHERE team_id = ?)`,
        [id],
      );
      // Alert history for this team's rules. Kept with the rules or not at all —
      // an event whose rule is gone says nothing about a threshold nobody can
      // look up.
      sqlite.run(
        `DELETE FROM alert_events WHERE rule_id IN (SELECT id FROM alert_rules WHERE team_id = ?)`,
        [id],
      );
      sqlite.run('DELETE FROM alert_rules WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM notification_channels WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM application_templates WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM volumes WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM api_keys WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM secrets WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM team_quotas WHERE team_id = ?', [id]);
      sqlite.run('UPDATE audit_logs SET team_id = NULL WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM team_members WHERE team_id = ?', [id]);
      sqlite.run('DELETE FROM teams WHERE id = ?', [id]);
    })(team.id);
  } catch (e: any) {
    // A foreign key that still holds means a table references teams.id and is
    // not handled above — name it rather than returning a bare 500.
    console.error(`[teams] Could not delete team ${team.id}:`, e);
    return json(
      { error: `Could not delete team: ${e?.message || 'unknown error'}` },
      { status: 500 },
    );
  }

  return json({ success: true });
}
