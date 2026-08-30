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
import {
  publishPlatformVersions,
  readPlatformVersions,
  readWorkerInfo,
} from '$lib/server/worker-info-cache';

/**
 * How stale a sweep snapshot may be before this asks the worker itself.
 *
 * Two collection intervals: long enough that an ordinary page load and its
 * poll always hit the cache, short enough that a worker which went down two
 * cycles ago is not still reported as up. `metrics_interval_seconds` can be
 * raised to an hour, so the ceiling is what actually bounds it.
 */
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;

export const POST: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  let sysInfo: any = null;
  let systemDf: any = null;
  let pingStatus = 'offline';
  let latencyMs: number | null = null;
  let platform: Awaited<ReturnType<typeof getPlatformVersions>> = [];
  let hostStats: HostStats | null = null;

  // The metrics sweep asks every worker these same questions on a timer. This
  // route used to ask them again on every call — ping, info, system df, three
  // container inspects for the platform versions, and the host metrics
  // endpoint — which the worker page then did on load and on a poll. Against a
  // worker that had just gone down, each reached its own timeout in turn and
  // the page hung for the better part of a minute to report what the sweep
  // already knew. See $lib/server/worker-info-cache.
  const cached = readWorkerInfo(workerId, MAX_SNAPSHOT_AGE_MS);

  if (cached) {
    sysInfo = cached.sysInfo;
    systemDf = cached.systemDf;
    hostStats = cached.hostStats;
    pingStatus = cached.status;
    latencyMs = cached.latencyMs;
  } else if (worker.podmanApiUrl) {
    // No sweep has covered this worker recently — it was added a moment ago, or
    // the control plane has just started. Ask it directly, once, and let the
    // sweep take over from the next cycle.
    const start = Date.now();
    await withPodman(worker, async (client) => {
      const ok = await client.ping();
      latencyMs = Date.now() - start;

      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch {}
        try { systemDf = await client.systemDf(); } catch {}
      }
    });

    // Host-level stats, from the worker's own metrics endpoint. There is no SSH
    // fallback: keys live in the browser vault, so the server cannot open a
    // session on its own. A worker that reports nothing leaves these null.
    if (pingStatus === 'online' && worker.baseDomain && worker.podmanCaCert) {
      try {
        hostStats = await getHostStatsHttp(worker as any);
      } catch (e) {
        console.warn('[worker-info] Host stats endpoint failed:', e);
      }
    }
  }

  // Not part of the sweep, and far more stable than the rest of this: Traefik
  // and CrowdSec versions change when a worker is re-provisioned, not between
  // two page loads. Its own longer TTL, and never fetched for a worker that is
  // not answering — three container inspects into a timeout, for a version
  // string that has not moved in a month.
  if (pingStatus === 'online') {
    const cachedPlatform = readPlatformVersions(workerId);
    if (cachedPlatform) {
      platform = cachedPlatform as typeof platform;
    } else {
      try {
        platform = await withPodman(worker, (client) => getPlatformVersions(client));
        publishPlatformVersions(workerId, platform);
      } catch (e) {
        console.warn('[worker-info] Platform versions failed:', e);
      }
    }
  }

  // Parse useful fields from sysInfo
  const host = sysInfo?.host;
  const store = sysInfo?.store;

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

  // Recorded only when this request actually reached the worker. Writing a ping
  // row for a cached answer would invent an availability sample that never
  // happened — and one per page load, at that, so the uptime history would be
  // dominated by whoever had the worker page open rather than by the sweep that
  // owns it. When the answer came from the cache, the sweep has already written
  // both of these.
  if (!cached) {
    await db.insert(workerPings).values({
      id: crypto.randomUUID(),
      workerId,
      pingedAt: new Date(),
      status: pingStatus as any,
      latencyMs,
      error: pingStatus === 'offline' ? 'Unreachable' : null,
    });

    await db.update(workers).set({
      status: pingStatus as any,
      lastSeenAt: pingStatus === 'online' ? new Date() : worker.lastSeenAt,
    }).where(eq(workers.id, workerId));
  }

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
