import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teams, teamMembers, users } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export async function GET({ cookies }: { cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  
  let allTeams;
  
  if (currentUser?.role === 'admin') {
    allTeams = await db.select().from(teams).all();
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);
    
    if (teamIds.length === 0) {
      return json([]);
    }
    
    allTeams = await db.select().from(teams).where(inArray(teams.id, teamIds)).all();
  }

  const teamsWithMembers = await Promise.all(
    allTeams.map(async (team) => {
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

      return {
        ...team,
        members: members.filter(m => m.username),
      };
    })
  );

  return json(teamsWithMembers);
}

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { name, description } = body;

  if (!name) {
    return json({ error: 'Team name is required' }, { status: 400 });
  }

  const slug = slugify(name);
  
  const existingSlug = await db.select().from(teams).where(eq(teams.slug, slug)).get();
  if (existingSlug) {
    return json({ error: 'Team with similar name already exists' }, { status: 400 });
  }

  const teamId = uuid();
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
}
