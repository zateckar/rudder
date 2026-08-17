/**
 * One alert rule. Admin-only: these handlers checked that a session existed and
 * nothing else, so any member could retune or delete any rule in the fleet —
 * including switching one to a channel belonging to another team.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { alertRules } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { authErrorResponse, requireAdmin } from '$lib/server/auth';

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  try {
    await requireAdmin(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { id } = params;
  const existing = await db.select().from(alertRules)
    .where(eq(alertRules.id, id))
    .get();
  if (!existing) return json({ error: 'Rule not found' }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (body.name !== undefined) updates.name = body.name;
  if (body.resourceType !== undefined) {
    if (!['worker', 'container', 'application'].includes(body.resourceType)) {
      return json({ error: 'resourceType must be worker, container, or application' }, { status: 400 });
    }
    updates.resourceType = body.resourceType;
  }
  if (body.resourceId !== undefined) updates.resourceId = body.resourceId || null;
  if (body.metric !== undefined) updates.metric = body.metric;
  if (body.operator !== undefined) {
    if (!['gt', 'lt', 'gte', 'lte', 'eq'].includes(body.operator)) {
      return json({ error: 'Invalid operator' }, { status: 400 });
    }
    updates.operator = body.operator;
  }
  if (body.threshold !== undefined) updates.threshold = Number(body.threshold);
  if (body.duration !== undefined) updates.duration = body.duration ? Number(body.duration) : null;
  if (body.channelId !== undefined) updates.channelId = body.channelId || null;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  await db.update(alertRules).set(updates).where(eq(alertRules.id, id));

  return json({ success: true });
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  try {
    await requireAdmin(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { id } = params;
  const existing = await db.select().from(alertRules)
    .where(eq(alertRules.id, id))
    .get();
  if (!existing) return json({ error: 'Rule not found' }, { status: 404 });

  await db.delete(alertRules).where(eq(alertRules.id, id));

  return json({ success: true });
};
