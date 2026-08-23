/** One notification channel. Admin-only, like the collection endpoint. */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { notificationChannels } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdminUser, route } from '$lib/server/auth';

export const PATCH: RequestHandler = route(async ({ params, request, locals }) => {
  requireAdminUser({ locals });

  const id = params.id!;
  const existing = await db.select().from(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .get();
  if (!existing) return json({ error: 'Channel not found' }, { status: 404 });

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
});

export const DELETE: RequestHandler = route(async ({ params, locals }) => {
  requireAdminUser({ locals });

  const id = params.id!;
  const existing = await db.select().from(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .get();
  if (!existing) return json({ error: 'Channel not found' }, { status: 404 });

  await db.delete(notificationChannels).where(eq(notificationChannels.id, id));

  return json({ success: true });
});
