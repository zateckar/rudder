import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users, workerPings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, type SSHConnectionConfig } from '$lib/server/ssh';
import { createPodmanClient, createSSHPodmanClient } from '$lib/server/podman';
import { getHostStats } from '$lib/server/host-metrics';

export const POST: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  try {
    let sysInfo: any = null;
    let systemDf: any = null;
    let pingStatus = 'offline';
    let latencyMs: number | null = null;

    const start = Date.now();

    if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      const client = createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      });

      const ok = await client.ping();
      latencyMs = Date.now() - start;

      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch {}
        try { systemDf = await client.systemDf(); } catch {}
      }

      client.destroy();
    } else if (worker.podmanApiUrl) {
      // Dev/local mode — no mTLS
      const client = createPodmanClient({ apiUrl: worker.podmanApiUrl });

      const ok = await client.ping();
      latencyMs = Date.now() - start;

      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch {}
        try { systemDf = await client.systemDf(); } catch {}
      }

      client.destroy();
    } else if (worker.sshKeyId) {
      const sshKey = await getSSHKey(worker.sshKeyId);
      if (sshKey) {
        const sshClient = createSSHPodmanClient({
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        });

        const ok = await sshClient.ping();
        latencyMs = Date.now() - start;

        if (ok) {
          pingStatus = 'online';
          try { sysInfo = await sshClient.info(); } catch {}
        }

        sshClient.destroy();
      }
    }

    // Parse useful fields from sysInfo
    const host = sysInfo?.host;
    const store = sysInfo?.store;

    // Collect host-level stats via SSH (fills gaps Podman API doesn't provide)
    let hostStats: Awaited<ReturnType<typeof getHostStats>> | null = null;
    if (worker.sshKeyId) {
      try {
        const sshKey = await getSSHKey(worker.sshKeyId);
        if (sshKey) {
          const sshConfig: SSHConnectionConfig = {
            host: worker.hostname,
            port: worker.sshPort,
            username: worker.sshUser,
            privateKey: sshKey.privateKey,
          };
          hostStats = await getHostStats(sshConfig);
        }
      } catch (e) {
        console.warn('[worker-info] SSH host stats failed, using Podman-only data:', e);
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

    // Extract system memory/CPU — prefer SSH host stats over Podman when available
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

    // Network — only available via SSH
    const netInfo = {
      rxBytes: hostStats?.netRxBytes ?? null,
      txBytes: hostStats?.netTxBytes ?? null,
    };

    // Store ping record
    const { v4: uuidv4 } = await import('uuid');
    await db.insert(workerPings).values({
      id: uuidv4(),
      workerId: params.id,
      pingedAt: new Date(),
      status: pingStatus as any,
      latencyMs,
      error: pingStatus === 'offline' ? 'Unreachable' : null,
    });

    // Update worker status
    await db.update(workers).set({
      status: pingStatus as any,
      lastSeenAt: pingStatus === 'online' ? new Date() : worker.lastSeenAt,
    }).where(eq(workers.id, params.id));

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
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
