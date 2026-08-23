import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { requireUser, route, userTeams } from '$lib/server/auth';
import { parseJsonBody, schemas } from '$lib/server/validation';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const GET: RequestHandler = route(async (event) => {
  requireUser(event);

  // This used to validate the session twice in a row — once inside an `if` that
  // discarded the result, then again to keep it.
  const allTeams = await userTeams(event);
  if (allTeams.length === 0) return json([]);

  // One query for every team's members, not one query per team. `AppLayout`
  // calls this on every page load, so the N+1 ran on every navigation.
  const memberRows = await db
    .select({
      teamId: teamMembers.teamId,
      id: users.id,
      username: users.username,
      email: users.email,
      fullName: users.fullName,
      role: teamMembers.role,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .leftJoin(users, eq(teamMembers.userId, users.id))
    .where(inArray(teamMembers.teamId, allTeams.map((t) => t.id)))
    .all();

  const byTeam = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    if (!row.username) continue; // membership pointing at a deleted user
    const bucket = byTeam.get(row.teamId) ?? [];
    bucket.push(row);
    byTeam.set(row.teamId, bucket);
  }

  return json(
    allTeams.map((team) => ({
      ...team,
      members: (byTeam.get(team.id) ?? []).map(({ teamId: _t, ...member }) => member),
    })),
  );
});

export const POST: RequestHandler = route(async (event) => {
  const userId = requireUser(event).user.id;

  const { name } = await parseJsonBody(event.request, schemas.createTeam);

  const slug = slugify(name);
  
  const existingSlug = await db.select().from(teams).where(eq(teams.slug, slug)).get();
  if (existingSlug) {
    return json({ error: 'Team with similar name already exists' }, { status: 400 });
  }

  const teamId = crypto.randomUUID();
  const now = new Date();

  await db.insert(teams).values({
    id: teamId,
    name,
    slug,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teamMembers).values({
    teamId,
    userId,
    role: 'owner',
    joinedAt: now,
  });

  return json({ id: teamId, name, slug });
});
