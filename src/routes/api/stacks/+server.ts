import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { stacks, applications, teams } from '$lib/db/schema';
import { eq, inArray, count } from 'drizzle-orm';
import { canWriteToTeam, requireUser, route, userTeams } from '$lib/server/auth';

/** GET: List stacks for the user's teams */
export const GET: RequestHandler = route(async (event) => {
  requireUser(event);

  const visible = await userTeams(event);
  const urlTeam = event.url.searchParams.get('team');

  const teamIds =
    urlTeam && urlTeam !== 'all'
      ? visible.filter((t) => t.id === urlTeam).map((t) => t.id)
      : visible.map((t) => t.id);

  if (teamIds.length === 0) return json([]);

  const allStacks = await db.select().from(stacks).where(inArray(stacks.teamId, teamIds)).all();
  if (allStacks.length === 0) return json([]);

  // Two queries, not two per stack: this ran a full `SELECT *` of every
  // application in a stack just to take `.length`, and re-fetched the owning
  // team row for each one.
  const counts = await db
    .select({ stackId: applications.stackId, n: count() })
    .from(applications)
    .where(inArray(applications.stackId, allStacks.map((s) => s.id)))
    .groupBy(applications.stackId)
    .all();
  const countByStack = new Map(counts.map((c) => [c.stackId, c.n]));
  const teamName = new Map(visible.map((t) => [t.id, t.name]));

  return json(
    allStacks.map((stack) => ({
      ...stack,
      appCount: countByStack.get(stack.id) ?? 0,
      teamName: (stack.teamId && teamName.get(stack.teamId)) || 'Unknown',
    })),
  );
});

/** POST: Create a stack */
export const POST: RequestHandler = route(async (event) => {
  const ctx = requireUser(event);

  const body = await event.request.json();
  const { name, description, teamId } = body;

  if (!name || !teamId) {
    return json({ error: 'Name and team are required' }, { status: 400 });
  }

  if (!(await canWriteToTeam(ctx, teamId))) {
    return json({ error: 'Not a member of this team' }, { status: 403 });
  }

  const userId = ctx.user.id;
  const now = new Date();
  const id = crypto.randomUUID();

  await db.insert(stacks).values({
    id,
    name,
    description: description || null,
    teamId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return json({ id, success: true });
});
