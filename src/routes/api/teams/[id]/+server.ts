import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, sqlite } from '$lib/db';
import { teams, teamMembers, users, applications } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { AuthorizationError, requireAdminUser, requireUser, route } from '$lib/server/auth';

/** A team the caller belongs to, or any team if they are an admin. */
async function readableTeam(
  event: { locals: App.Locals },
  teamId: string,
): Promise<typeof teams.$inferSelect> {
  const ctx = requireUser(event);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new AuthorizationError('Team not found', 404);

  if (ctx.user.role === 'admin') return team;

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, ctx.user.id)))
    .get();

  if (!membership) throw new AuthorizationError('Access denied', 403);

  return team;
}

/**
 * A team an admin may reshape or remove.
 *
 * Renaming and deleting used to be an owner's prerogative. Teams are flat now, so
 * the tier that could do it no longer exists and both are admin work — which is
 * also the only reading under which a team created by OIDC group sync, which
 * never had an owner, is administrable at all.
 */
async function administrableTeam(
  event: { locals: App.Locals },
  teamId: string,
): Promise<typeof teams.$inferSelect> {
  requireAdminUser(event);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new AuthorizationError('Team not found', 404);

  return team;
}

export const GET: RequestHandler = route(async (event) => {
  const team = await readableTeam(event, event.params.id!);

  const members = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    joinedAt: teamMembers.joinedAt,
  })
    .from(teamMembers)
    .leftJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, team.id))
    .all();

  return json({
    ...team,
    members: members.filter(m => m.username),
  });
});

export const PATCH: RequestHandler = route(async (event) => {
  const teamId = event.params.id!;
  await administrableTeam(event, teamId);

  const body = await event.request.json().catch(() => null);
  const rawName = body?.name;

  const updates: any = { updatedAt: new Date() };

  if (rawName !== undefined) {
    if (typeof rawName !== 'string') {
      return json({ error: 'name must be a string' }, { status: 400 });
    }
    const name = rawName.trim();
    if (!name) {
      return json({ error: 'name cannot be empty' }, { status: 400 });
    }
    if (name.length > 100) {
      return json({ error: 'name is too long (maximum 100 characters)' }, { status: 400 });
    }

    // Case-insensitive collision check, which `teams.name UNIQUE` does not give
    // us: SQLite compares text case-sensitively without COLLATE NOCASE, so
    // "Platform" and "platform" can both exist. OIDC group sync
    // (`syncUserTeams`) keys its lookup on `name.toLowerCase()`, so a second
    // team differing only in case makes the group claim resolve to whichever row
    // the map happened to keep — a rename was enough to divert another team's
    // OIDC members into a team of the caller's own.
    const collision = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .all();
    const clash = collision.find(
      (t) => t.id !== teamId && t.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      return json(
        {
          error:
            `Another team is already named "${clash.name}". Team names must differ by more ` +
            `than capitalisation, because identity-provider group names are matched ` +
            `case-insensitively.`,
        },
        { status: 409 },
      );
    }

    updates.name = name;
  }

  await db.update(teams).set(updates).where(eq(teams.id, teamId));

  return json({ success: true });
});

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
 * Applications are deliberately *not* removed. They are running
 * infrastructure with containers behind them, and destroying it as a side effect
 * of tidying up a team is not this endpoint's decision to make; the caller is
 * told to move or delete them first.
 *
 * Audit rows are unlinked rather than deleted. They are the record of what was
 * done to the team, which is precisely what you still want once it is gone.
 */
export const DELETE: RequestHandler = route(async (event) => {
  const team = await administrableTeam(event, event.params.id!);

  const ownedApps = await db
    .select({ id: applications.id, name: applications.name })
    .from(applications)
    .where(eq(applications.teamId, team.id))
    .all();

  if (ownedApps.length > 0) {
    const blockers = ownedApps.map((a) => `application "${a.name}"`);
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
});
