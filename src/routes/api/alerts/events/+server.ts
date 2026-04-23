import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { alertEvents, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return json({ error: 'User not found' }, { status: 404 });

  const acknowledgedFilter = url.searchParams.get('acknowledged');

  let rows;
  if (acknowledgedFilter === 'false') {
    rows = await db.select().from(alertEvents)
      .where(eq(alertEvents.acknowledged, false))
      .orderBy(desc(alertEvents.createdAt))
      .limit(100)
      .all();
  } else if (acknowledgedFilter === 'true') {
    rows = await db.select().from(alertEvents)
      .where(eq(alertEvents.acknowledged, true))
      .orderBy(desc(alertEvents.createdAt))
      .limit(100)
      .all();
  } else {
    rows = await db.select().from(alertEvents)
      .orderBy(desc(alertEvents.createdAt))
      .limit(100)
      .all();
  }

  const result = rows.map(ev => ({
    ...ev,
    createdAt: ev.createdAt instanceof Date ? ev.createdAt.toISOString() : new Date(ev.createdAt as any).toISOString(),
  }));

  return json(result);
};

/** PATCH to acknowledge an event — pass { id, acknowledged: true } */
export const PATCH: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { id, acknowledged } = body;

  if (!id) return json({ error: 'Event ID required' }, { status: 400 });

  const existing = await db.select().from(alertEvents)
    .where(eq(alertEvents.id, id))
    .get();
  if (!existing) return json({ error: 'Event not found' }, { status: 404 });

  await db.update(alertEvents)
    .set({ acknowledged: acknowledged !== undefined ? acknowledged : true })
    .where(eq(alertEvents.id, id));

  return json({ success: true });
};
