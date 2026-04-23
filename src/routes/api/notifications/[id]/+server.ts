import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { notificationChannels, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const { id } = params;
  const existing = await db.select().from(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .get();
  if (!existing) return json({ error: 'Channel not found' }, { status: 404 });

  // Only admin or creator can update
  if (user.role !== 'admin' && existing.createdBy !== userId) {
    return json({ error: 'Not authorized' }, { status: 403 });
  }

  const body = await request.json();
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (body.name !== undefined) updates.name = body.name;
  if (body.type !== undefined) {
    if (!['webhook', 'slack', 'email'].includes(body.type)) {
      return json({ error: 'type must be webhook, slack, or email' }, { status: 400 });
    }
    updates.type = body.type;
  }
  if (body.config !== undefined) {
    if (typeof body.config === 'string') {
      try { JSON.parse(body.config); } catch {
        return json({ error: 'config must be valid JSON' }, { status: 400 });
      }
      updates.config = body.config;
    } else {
      updates.config = JSON.stringify(body.config);
    }
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id));

  return json({ success: true });
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const { id } = params;
  const existing = await db.select().from(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .get();
  if (!existing) return json({ error: 'Channel not found' }, { status: 404 });

  if (user.role !== 'admin' && existing.createdBy !== userId) {
    return json({ error: 'Not authorized' }, { status: 403 });
  }

  await db.delete(notificationChannels).where(eq(notificationChannels.id, id));

  return json({ success: true });
};
