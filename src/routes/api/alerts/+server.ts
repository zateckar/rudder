/**
 * Alert rules. Admin-only for the same reasons as the channels they point at:
 * a rule describes the whole fleet, and one created with no `teamId` is global
 * — which the previous membership check, being conditional on `teamId` being
 * present, did nothing to prevent.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { alertRules, notificationChannels } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const rows = await db.select().from(alertRules).all();

  const result = rows.map(r => ({
    ...r,
    lastTriggeredAt: r.lastTriggeredAt ? (r.lastTriggeredAt instanceof Date ? r.lastTriggeredAt.toISOString() : new Date(r.lastTriggeredAt as any).toISOString()) : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt as any).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt as any).toISOString(),
  }));

  return json(result);
});

export const POST: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const body = await event.request.json();
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

  const now = new Date();
  const id = crypto.randomUUID();

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
});
