import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, workerPings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import type { HostStats } from '$lib/server/host-metrics';
import { getHostStatsHttp } from '$lib/server/host-metrics-http';
import { getPlatformVersions } from '$lib/server/platform-versions';
import { requireWorker, route } from '$lib/server/auth';

export const POST: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  let sysInfo: any = null;
  let systemDf: any = null;
  let pingStatus = 'offline';
  let latencyMs: number | null = null;
  let platform: Awaited<ReturnType<typeof getPlatformVersions>> = [];

  const start = Date.now();

  if (worker.podmanApiUrl) {
    await withPodman(worker, async (client) => {
      const ok = await client.ping();
      latencyMs = Date.now() - start;

      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch {}
        try { systemDf = await client.systemDf(); } catch {}
        try { platform = await getPlatformVersions(client); } catch {}
      }
    });
  }

  // Parse useful fields from sysInfo
  const host = sysInfo?.host;
  const store = sysInfo?.store;

  // Host-level stats, from the worker's own metrics endpoint. There is no SSH
  // fallback: keys live in the browser vault, so the server cannot open a
  // session on its own. A worker that reports nothing leaves these null.
  let hostStats: HostStats | null = null;
  if (worker.baseDomain && worker.podmanCaCert) {
    try {
      hostStats = await getHostStatsHttp(worker as any);
    } catch (e) {
      console.warn('[worker-info] Host stats endpoint failed:', e);
    }
  }

  // Parse disk usage from systemDf
  let diskUsage: { images: number; containers: number; volumes: number; total: number } | null = null;
  if (systemDf) {
    const imagesSize = (systemDf.ImagesDiskUsage || []).reduce((s: number, i: any) => s + (i.Size || 0), 0);
    const containersSize = (systemDf.ContainersDiskUsage || []).reduce((s: number, c: any) => s + (c.Size || 0), 0);
    const volumesSize = (systemDf.VolumesDiskUsage || []).reduce((s: number, v: any) => s + (v.UsageData?.Size || 0), 0);
    diskUsage = {
      images: imagesSize,
      containers: containersSize,
      volumes: volumesSize,
      total: imagesSize + containersSize + volumesSize,
    };
  }

  // Extract system memory/CPU — prefer the host metrics endpoint over Podman's
  // own view, which reports the container runtime's numbers rather than the
  // machine's.
  const cpuInfo = {
    model: host?.cpu?.[0]?.modelName || null,
    cores: hostStats?.cpuCores ?? host?.cpuUtilization?.cpus ?? host?.cpus ?? null,
    percent: hostStats?.cpuPercent ?? host?.cpuUtilization?.userPercent ?? null,
  };

  const memInfo = {
    total: hostStats?.memTotal ?? host?.memTotal ?? null,
    free: hostStats?.memFree ?? host?.memFree ?? null,
    available: hostStats?.memAvailable ?? host?.memAvailable ?? null,
    used: hostStats?.memUsed ?? (host?.memTotal && host?.memFree ? host.memTotal - host.memFree : null),
    percent: hostStats?.memPercent ?? (host?.memTotal && host?.memFree
      ? Math.round(((host.memTotal - host.memFree) / host.memTotal) * 10000) / 100
      : null),
  };

  // Disk info — combine Podman-managed usage with host-level disk stats
  const diskInfo = {
    ...diskUsage,
    hostTotal: hostStats?.diskTotal ?? null,
    hostUsed: hostStats?.diskUsed ?? null,
    hostAvailable: hostStats?.diskAvailable ?? null,
    hostPercent: hostStats?.diskPercent ?? null,
  };

  // Network — only the host metrics endpoint reports this.
  const netInfo = {
    rxBytes: hostStats?.netRxBytes ?? null,
    txBytes: hostStats?.netTxBytes ?? null,
  };

  // Store ping record
  await db.insert(workerPings).values({
    id: crypto.randomUUID(),
    workerId,
    pingedAt: new Date(),
    status: pingStatus as any,
    latencyMs,
    error: pingStatus === 'offline' ? 'Unreachable' : null,
  });

  // Update worker status
  await db.update(workers).set({
    status: pingStatus as any,
    lastSeenAt: pingStatus === 'online' ? new Date() : worker.lastSeenAt,
  }).where(eq(workers.id, workerId));

  return json({
    status: pingStatus,
    latencyMs,
    host: {
      hostname: host?.hostname || sysInfo?._raw?.Name || null,
      os: host?.os || sysInfo?._raw?.OperatingSystem || null,
      kernelVersion: host?.kernel || host?.kernelVersion || sysInfo?._raw?.KernelVersion || null,
      arch: host?.arch || sysInfo?._raw?.Architecture || null,
      uptime: host?.uptime || sysInfo?._raw?.Uptime || null,
    },
    cpu: cpuInfo,
    memory: memInfo,
    disk: diskInfo,
    network: netInfo,
    store: {
      imageCount: store?.imageStore?.number ?? store?.imageCount ?? null,
      volumeCount: store?.volumeStore?.number ?? null,
      graphDriver: store?.graphDriverName || null,
      graphRoot: store?.graphRoot || null,
    },
    containers: {
      running: sysInfo?.store?.containerStore?.running ?? null,
      paused: sysInfo?.store?.containerStore?.paused ?? null,
      stopped: sysInfo?.store?.containerStore?.stopped ?? null,
      total: sysInfo?.store?.containerStore?.number ?? null,
    },
    podmanVersion: sysInfo?.version?.Version || sysInfo?.version || null,
    platform,
    // Patch state comes from the worker's daily scan via the metrics
    // endpoint; null throughout when it has never reported one.
    patch: {
      updatesPending: hostStats?.updatesPending ?? null,
      updatesSecurity: hostStats?.updatesSecurity ?? null,
      rebootRequired: hostStats?.rebootRequired ?? null,
    },
  });
});
