import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers, containers, workerPings, workerMetrics } from '$lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { canManageWorker } from '$lib/server/auth';

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  let access;
  try {
    access = await canManageWorker(cookies, params.id);
  } catch (e: any) {
    if (e.statusCode === 401) throw redirect(303, '/login');
    if (e.statusCode === 403) throw redirect(303, '/dashboard');
    if (e.statusCode === 404) throw error(404, 'Worker not found');
    throw e;
  }

  const { ctx, worker } = access;

  const workerContainers = await db.select().from(containers).where(eq(containers.workerId, params.id)).all();

  const since = new Date(Date.now() - 24 * 3600 * 1000);

  const pings = await db.select()
    .from(workerPings)
    .where(and(eq(workerPings.workerId, params.id), gte(workerPings.pingedAt, since)))
    .orderBy(desc(workerPings.pingedAt))
    .limit(200)
    .all();

  const metrics = await db.select()
    .from(workerMetrics)
    .where(and(eq(workerMetrics.workerId, params.id), gte(workerMetrics.collectedAt, since)))
    .orderBy(desc(workerMetrics.collectedAt))
    .limit(500)
    .all();

  const totalPings = pings.length;
  const onlinePings = pings.filter(p => p.status === 'online').length;
  const uptimePercent = totalPings > 0 ? Math.round((onlinePings / totalPings) * 10000) / 100 : null;
  const avgLatency = pings.filter(p => p.latencyMs != null).length > 0
    ? Math.round(pings.filter(p => p.latencyMs != null).reduce((s, p) => s + (p.latencyMs || 0), 0) / pings.filter(p => p.latencyMs != null).length)
    : null;

  return {
    user: ctx.user,
    worker,
    containers: workerContainers,
    pings: pings.map(p => ({
      ...p,
      pingedAt: p.pingedAt instanceof Date ? p.pingedAt.toISOString() : String(p.pingedAt),
    })),
    metrics: metrics.map(m => ({
      ...m,
      collectedAt: m.collectedAt instanceof Date ? m.collectedAt.toISOString() : String(m.collectedAt),
    })),
    uptimePercent,
    avgLatency,
  };
};
