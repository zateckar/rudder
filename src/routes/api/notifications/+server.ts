import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { notificationChannels, users, teamMembers } from '$lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export const GET: RequestHandler = async ({ cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  let rows;
  if (user.role === 'admin') {
    rows = await db.select().from(notificationChannels).all();
  } else {
    // Members see channels from their teams + global (no teamId)
    const memberships = await db.select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    const teamIds = memberships.map(m => m.teamId);

    if (teamIds.length > 0) {
      rows = await db.select().from(notificationChannels)
        .where(or(
          ...teamIds.map(tid => eq(notificationChannels.teamId, tid)),
          eq(notificationChannels.teamId, '')
        ))
        .all();
      // Also include channels with null teamId (global)
      const globalRows = await db.select().from(notificationChannels).all();
      const teamChannelIds = new Set(rows.map(r => r.id));
      for (const row of globalRows) {
        if (!row.teamId && !teamChannelIds.has(row.id)) {
          rows.push(row);
        }
      }
    } else {
      // No teams — only global channels
      const allRows = await db.select().from(notificationChannels).all();
      rows = allRows.filter(r => !r.teamId);
    }
  }

  const result = rows.map(ch => ({
    ...ch,
    createdAt: ch.createdAt instanceof Date ? ch.createdAt.toISOString() : new Date(ch.createdAt as any).toISOString(),
    updatedAt: ch.updatedAt instanceof Date ? ch.updatedAt.toISOString() : new Date(ch.updatedAt as any).toISOString(),
  }));

  return json(result);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const body = await request.json();
  const { name, type, config, teamId } = body;

  if (!name || !type || !config) {
    return json({ error: 'name, type, and config are required' }, { status: 400 });
  }

  if (!['webhook', 'slack', 'email'].includes(type)) {
    return json({ error: 'type must be webhook, slack, or email' }, { status: 400 });
  }

  // Validate config is valid JSON (or already an object)
  let configStr: string;
  if (typeof config === 'string') {
    try {
      JSON.parse(config);
      configStr = config;
    } catch {
      return json({ error: 'config must be valid JSON' }, { status: 400 });
    }
  } else {
    configStr = JSON.stringify(config);
  }

  // Non-admins must provide a teamId they belong to
  if (user.role !== 'admin' && teamId) {
    const membership = await db.select().from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    const memberTeamIds = membership.map(m => m.teamId);
    if (!memberTeamIds.includes(teamId)) {
      return json({ error: 'Not a member of this team' }, { status: 403 });
    }
  }

  const now = new Date();
  const id = uuid();

  await db.insert(notificationChannels).values({
    id,
    name,
    type,
    config: configStr,
    enabled: true,
    teamId: teamId || null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return json({ id, name, type }, { status: 201 });
};
