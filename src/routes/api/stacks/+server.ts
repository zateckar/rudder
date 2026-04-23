import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { stacks, applications, teams, teamMembers, users } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

/** GET: List stacks for the user's teams */
export async function GET({ cookies }: { cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  let teamIds: string[];
  if (currentUser?.role === 'admin') {
    const allTeams = await db.select().from(teams).all();
    teamIds = allTeams.map(t => t.id);
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    teamIds = memberships.map(m => m.teamId);
  }

  if (teamIds.length === 0) return json([]);

  const allStacks = await db.select().from(stacks).where(inArray(stacks.teamId, teamIds)).all();

  // Get app counts and team names
  const result = [];
  for (const stack of allStacks) {
    const apps = await db.select().from(applications).where(eq(applications.stackId, stack.id)).all();
    const team = stack.teamId ? await db.select().from(teams).where(eq(teams.id, stack.teamId)).get() : null;
    result.push({
      ...stack,
      appCount: apps.length,
      teamName: team?.name ?? 'Unknown',
    });
  }

  return json(result);
}

/** POST: Create a stack */
export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, description, teamId } = body;

  if (!name || !teamId) {
    return json({ error: 'Name and team are required' }, { status: 400 });
  }

  // Verify team membership
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (currentUser?.role !== 'admin') {
    const membership = await db.select().from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .all();
    if (!membership.find(m => m.userId === userId)) {
      return json({ error: 'Not a member of this team' }, { status: 403 });
    }
  }

  const now = new Date();
  const id = uuid();

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
}
