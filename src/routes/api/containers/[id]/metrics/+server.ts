import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, containerMetrics } from '$lib/db/schema';
import { eq, and, gte, asc } from 'drizzle-orm';

const RANGES: Record<string, number> = {
  '1h':  1  * 60 * 60 * 1000,
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export async function GET({
  params,
  url,
  cookies,
}: {
  params: { id: string };
  url: URL;
  cookies: any;
}) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbContainer = await db
    .select()
    .from(containers)
    .where(eq(containers.id, params.id))
    .get();

  if (!dbContainer) {
    return json({ error: 'Container not found' }, { status: 404 });
  }

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
        eq(containerMetrics.containerId, params.id),
        gte(containerMetrics.collectedAt, fromDate)
      )
    )
    .orderBy(asc(containerMetrics.collectedAt))
    .all();

  const points = rows.map((r) => ({
    ts: r.collectedAt instanceof Date ? r.collectedAt.getTime() : r.collectedAt,
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
    containerId: params.id,
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
}
