import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workerPings } from '$lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async ({ params, url, locals }) => {
  requireAdminUser({ locals });

  const hours = parseInt(url.searchParams.get('hours') || '24');
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const pings = await db.select()
    .from(workerPings)
    .where(and(
      eq(workerPings.workerId, params.id!),
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
});
