import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workerPings, users } from '$lib/db/schema';
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

  const pings = await db.select()
    .from(workerPings)
    .where(and(
      eq(workerPings.workerId, params.id),
      gte(workerPings.pingedAt, since)
    ))
    .orderBy(desc(workerPings.pingedAt))
    .limit(500)
    .all();

  const total = pings.length;
  const online = pings.filter(p => p.status === 'online').length;
  const uptimePercent = total > 0 ? Math.round((online / total) * 10000) / 100 : null;
  const avgLatency = pings.filter(p => p.latencyMs != null).length > 0
    ? Math.round(pings.filter(p => p.latencyMs != null).reduce((s, p) => s + (p.latencyMs || 0), 0) / pings.filter(p => p.latencyMs != null).length)
    : null;

  return json({
    pings: pings.map(p => ({
      ...p,
      pingedAt: p.pingedAt instanceof Date ? p.pingedAt.toISOString() : p.pingedAt,
    })),
    summary: { total, online, uptimePercent, avgLatency },
  });
};
