import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, workerMetrics, workerPings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

/** Collect one worker's metrics now, rather than waiting for the timer. */
export const POST: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  const start = Date.now();

  // Returned from the callback rather than assigned into closure variables:
  // TypeScript cannot see that an async callback ran, so a `let` written only
  // inside one stays narrowed to its initialiser and every later comparison
  // against it reads as unreachable.
  const probe = worker.podmanApiUrl
    ? await withPodman(worker, async (client) => {
        if (!(await client.ping())) return { status: 'offline' as const };
        let sysInfo: any = null;
        let systemDf: any = null;
        try { sysInfo = await client.info(); } catch (e) { console.error(`[collect] info() failed for ${worker.name}:`, (e as any).message || e); }
        try { systemDf = await client.systemDf(); } catch (e) { console.error(`[collect] systemDf() failed for ${worker.name}:`, (e as any).message || e); }
        return { status: 'online' as const, sysInfo, systemDf };
      })
    : { status: 'offline' as const };

  const pingStatus: 'online' | 'offline' | 'error' = probe.status;
  const sysInfo = 'sysInfo' in probe ? probe.sysInfo : null;
  const systemDf = 'systemDf' in probe ? probe.systemDf : null;

  const latencyMs = Date.now() - start;
  const now = new Date();

  await db.insert(workerPings).values({
    id: crypto.randomUUID(),
    workerId,
    pingedAt: now,
    status: pingStatus,
    latencyMs,
    error: pingStatus !== 'online' ? 'Unreachable' : null,
  });

  await db.update(workers).set({
    status: pingStatus,
    lastSeenAt: pingStatus === 'online' ? now : worker.lastSeenAt,
  }).where(eq(workers.id, workerId));

  if (pingStatus !== 'online' || !sysInfo) {
    return json({ success: true, collected: false, status: pingStatus });
  }

  const host = sysInfo.host || {};
  const store = sysInfo.store || {};

  const memTotal = host.memTotal || null;
  const memFree = host.memFree || null;
  const memUsed = memTotal && memFree ? memTotal - memFree : null;
  const memPercent = memTotal && memUsed ? Math.round((memUsed / memTotal) * 10000) / 100 : null;

  let diskUsage: number | null = null;
  if (systemDf) {
    const imagesSize = (systemDf.ImagesDiskUsage || []).reduce((s: number, i: any) => s + (i.Size || 0), 0);
    const containersSize = (systemDf.ContainersDiskUsage || []).reduce((s: number, c: any) => s + (c.Size || 0), 0);
    const volumesSize = (systemDf.VolumesDiskUsage || []).reduce((s: number, v: any) => s + (v.UsageData?.Size || 0), 0);
    diskUsage = imagesSize + containersSize + volumesSize;
  }

  // Host disk, network and CPU are left null here on purpose. They come from
  // the worker's metrics endpoint, which the background collector reads; this
  // route is the "collect now" button and only refreshes what the Podman API
  // itself reports. It previously declared five `let host*` variables, assigned
  // none of them, and wrote the nulls — the same result, at greater length.
  await db.insert(workerMetrics).values({
    id: crypto.randomUUID(),
    workerId,
    collectedAt: now,
    cpuPercent: host.cpuUtilization?.userPercent ?? null,
    memUsageBytes: memUsed,
    memLimitBytes: memTotal,
    memPercent,
    diskUsageBytes: diskUsage,
    diskLimitBytes: null,
    diskPercent: null,
    netRxBytes: null,
    netTxBytes: null,
    containersRunning: store.containerStore?.running ?? null,
    containersTotal: store.containerStore?.number ?? null,
    imagesCount: store.imageStore?.number ?? null,
    volumesCount: store.volumeStore?.number ?? null,
  });

  return json({ success: true, collected: true, status: pingStatus });
});
