import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workerMetrics } from '$lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async ({ params, url, locals }) => {
  requireAdminUser({ locals });

  const hours = parseInt(url.searchParams.get('hours') || '24');
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const metrics = await db.select()
    .from(workerMetrics)
    .where(and(
      eq(workerMetrics.workerId, params.id!),
      gte(workerMetrics.collectedAt, since)
    ))
    .orderBy(desc(workerMetrics.collectedAt))
    .limit(5000)
    .all();

  return json(metrics.map(m => ({
    ...m,
    collectedAt: m.collectedAt instanceof Date ? m.collectedAt.toISOString() : m.collectedAt,
  })));
});
