import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { alertRules, users, teamMembers, notificationChannels } from '$lib/db/schema';
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
    rows = await db.select().from(alertRules).all();
  } else {
    const memberships = await db.select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    const teamIds = memberships.map(m => m.teamId);

    if (teamIds.length > 0) {
      rows = await db.select().from(alertRules)
        .where(or(...teamIds.map(tid => eq(alertRules.teamId, tid))))
        .all();
      // Also include global rules (null teamId)
      const allRows = await db.select().from(alertRules).all();
      const ruleIds = new Set(rows.map(r => r.id));
      for (const row of allRows) {
        if (!row.teamId && !ruleIds.has(row.id)) {
          rows.push(row);
        }
      }
    } else {
      const allRows = await db.select().from(alertRules).all();
      rows = allRows.filter(r => !r.teamId);
    }
  }

  const result = rows.map(r => ({
    ...r,
    lastTriggeredAt: r.lastTriggeredAt ? (r.lastTriggeredAt instanceof Date ? r.lastTriggeredAt.toISOString() : new Date(r.lastTriggeredAt as any).toISOString()) : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt as any).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt as any).toISOString(),
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
  const { name, resourceType, resourceId, metric, operator, threshold, duration, channelId, teamId } = body;

  if (!name || !resourceType || !metric || threshold === undefined) {
    return json({ error: 'name, resourceType, metric, and threshold are required' }, { status: 400 });
  }

  if (!['worker', 'container', 'application'].includes(resourceType)) {
    return json({ error: 'resourceType must be worker, container, or application' }, { status: 400 });
  }

  const validOperators = ['gt', 'lt', 'gte', 'lte', 'eq'];
  if (operator && !validOperators.includes(operator)) {
    return json({ error: `operator must be one of: ${validOperators.join(', ')}` }, { status: 400 });
  }

  // Validate channelId exists if provided
  if (channelId) {
    const channel = await db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .get();
    if (!channel) {
      return json({ error: 'Notification channel not found' }, { status: 400 });
    }
  }

  // Non-admins must belong to the team
  if (user.role !== 'admin' && teamId) {
    const membership = await db.select().from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .all();
    if (!membership.some(m => m.teamId === teamId)) {
      return json({ error: 'Not a member of this team' }, { status: 403 });
    }
  }

  const now = new Date();
  const id = uuid();

  await db.insert(alertRules).values({
    id,
    name,
    resourceType,
    resourceId: resourceId || null,
    metric,
    operator: operator || 'gt',
    threshold: Number(threshold),
    duration: duration ? Number(duration) : null,
    channelId: channelId || null,
    enabled: true,
    teamId: teamId || null,
    lastTriggeredAt: null,
    createdAt: now,
    updatedAt: now,
  });

  return json({ id, name }, { status: 201 });
};
