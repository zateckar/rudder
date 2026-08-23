import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containerMetrics } from '$lib/db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireContainerScoped, route } from '$lib/server/auth';
import { formatBytes } from '$lib/format';

const RANGES: Record<string, number> = {
  '1h':  1  * 60 * 60 * 1000,
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const GET: RequestHandler = route(async ({ params, url, locals }) => {
  const containerId = params.id!;
  const { container: dbContainer } = await requireContainerScoped({ locals }, containerId);

  const rangeParam = url.searchParams.get('range') ?? '1h';
  const fromParam = url.searchParams.get('from');
  const toParam   = url.searchParams.get('to');

  let fromMs: number;
  let toMs = Date.now();

  if (fromParam && toParam) {
    fromMs = parseInt(fromParam);
    toMs   = parseInt(toParam);
  } else {
    const rangeMs = RANGES[rangeParam] ?? RANGES['1h'];
    fromMs = toMs - rangeMs;
  }

  const fromDate = new Date(fromMs);

  const rows = await db
    .select()
    .from(containerMetrics)
    .where(
      and(
        eq(containerMetrics.containerId, containerId),
        sql`${containerMetrics.collectedAt} >= ${Math.floor(fromMs / 1000)}`
      )
    )
    .orderBy(asc(containerMetrics.collectedAt))
    .all();

  const points = rows.map((r) => ({
    ts: (() => {
      const d = new Date(r.collectedAt);
      const ms = d.getTime();
      // If the timestamp is in seconds (less than year 2286), convert to ms
      return ms < 10000000000 ? ms * 1000 : ms;
    })(),
    cpuPercent:       r.cpuPercent ?? 0,
    memUsageBytes:    r.memUsageBytes ?? 0,
    memLimitBytes:    r.memLimitBytes ?? 0,
    memPercent:       r.memPercent ?? 0,
    netRxBytes:       r.netRxBytes ?? 0,
    netTxBytes:       r.netTxBytes ?? 0,
    blockReadBytes:   r.blockReadBytes ?? 0,
    blockWriteBytes:  r.blockWriteBytes ?? 0,
    // Human-readable extras
    memUsageHuman:    formatBytes(r.memUsageBytes ?? 0),
    memLimitHuman:    formatBytes(r.memLimitBytes ?? 0),
    netRxHuman:       formatBytes(r.netRxBytes ?? 0),
    netTxHuman:       formatBytes(r.netTxBytes ?? 0),
  }));

  return json({
    containerId,
    containerName: dbContainer.name,
    range: rangeParam,
    from: fromMs,
    to: toMs,
    points,
    // Summary stats
    summary: points.length > 0 ? {
      cpuAvg: Math.round(points.reduce((a, p) => a + p.cpuPercent, 0) / points.length * 100) / 100,
      cpuMax: Math.max(...points.map(p => p.cpuPercent)),
      memAvgPercent: Math.round(points.reduce((a, p) => a + p.memPercent, 0) / points.length * 100) / 100,
      memMaxBytes: Math.max(...points.map(p => p.memUsageBytes)),
    } : null,
  });
});
