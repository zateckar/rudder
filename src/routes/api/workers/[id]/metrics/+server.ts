import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workerMetrics, users } from '$lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const hours = parseInt(url.searchParams.get('hours') || '24');
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const metrics = await db.select()
    .from(workerMetrics)
    .where(and(
      eq(workerMetrics.workerId, params.id),
      gte(workerMetrics.collectedAt, since)
    ))
    .orderBy(desc(workerMetrics.collectedAt))
    .limit(5000)
    .all();

  return json(metrics.map(m => ({
    ...m,
    collectedAt: m.collectedAt instanceof Date ? m.collectedAt.toISOString() : m.collectedAt,
  })));
};
