import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users, workerMetrics, workerPings } from '$lib/db/schema';
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
    const start = Date.now();
    let sysInfo: any = null;
    let systemDf: any = null;
    let pingStatus: 'online' | 'offline' | 'error' = 'offline';

    if (worker.podmanApiUrl && worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey) {
      const client = createPodmanClient({
        apiUrl: worker.podmanApiUrl,
        caCert: worker.podmanCaCert,
        clientCert: worker.podmanClientCert,
        clientKey: worker.podmanClientKey,
      });

      const ok = await client.ping();
      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch (e) { console.error(`[collect] info() failed for ${worker.name}:`, e); }
        try { systemDf = await client.systemDf(); } catch (e) { console.error(`[collect] systemDf() failed for ${worker.name}:`, e); }
      }
      client.destroy();
    } else if (worker.podmanApiUrl) {
      // Dev/local mode — no mTLS
      const client = createPodmanClient({ apiUrl: worker.podmanApiUrl });
      const ok = await client.ping();
      if (ok) {
        pingStatus = 'online';
        try { sysInfo = await client.info(); } catch (e) { console.error(`[collect] info() failed for ${worker.name}:`, e); }
        try { systemDf = await client.systemDf(); } catch (e) { console.error(`[collect] systemDf() failed for ${worker.name}:`, e); }
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
        if (ok) {
          pingStatus = 'online';
          try { sysInfo = await sshClient.info(); } catch (e) { console.error(`[collect] info() failed for ${worker.name} (SSH):`, e); }
        }
        sshClient.destroy();
      }
    }

    const latencyMs = Date.now() - start;
    const { v4: uuidv4 } = await import('uuid');
    const now = new Date();

    // Store ping
    await db.insert(workerPings).values({
      id: uuidv4(),
      workerId: params.id,
      pingedAt: now,
      status: pingStatus,
      latencyMs,
      error: pingStatus !== 'online' ? 'Unreachable' : null,
    });

    // Update worker status
    await db.update(workers).set({
      status: pingStatus,
      lastSeenAt: pingStatus === 'online' ? now : worker.lastSeenAt,
    }).where(eq(workers.id, params.id));

    if (pingStatus !== 'online' || !sysInfo) {
      return json({ success: true, collected: false, status: pingStatus });
    }

    // Extract metrics
    const host = sysInfo.host || {};
    const store = sysInfo.store || {};

    const memTotal = host.memTotal || null;
    const memFree = host.memFree || null;
    const memUsed = memTotal && memFree ? memTotal - memFree : null;
    const memPercent = memTotal && memUsed ? Math.round((memUsed / memTotal) * 10000) / 100 : null;

    let diskUsage = null;
    if (systemDf) {
      const imagesSize = (systemDf.ImagesDiskUsage || []).reduce((s: number, i: any) => s + (i.Size || 0), 0);
      const containersSize = (systemDf.ContainersDiskUsage || []).reduce((s: number, c: any) => s + (c.Size || 0), 0);
      const volumesSize = (systemDf.VolumesDiskUsage || []).reduce((s: number, v: any) => s + (v.UsageData?.Size || 0), 0);
      diskUsage = imagesSize + containersSize + volumesSize;
    }

    // Collect host-level stats via SSH (fills gaps Podman API doesn't provide)
    let hostCpu: number | null = host.cpuUtilization?.userPercent ?? null;
    let hostDiskLimit: number | null = null;
    let hostDiskPercent: number | null = null;
    let hostNetRx: number | null = null;
    let hostNetTx: number | null = null;
    let hostMemTotal: number | null = memTotal;
    let hostMemUsed: number | null = memUsed;
    let hostMemPercent: number | null = memPercent;

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
          const hostStats = await getHostStats(sshConfig);
          if (hostStats.cpuPercent != null) hostCpu = hostStats.cpuPercent;
          if (hostStats.diskTotal != null) hostDiskLimit = hostStats.diskTotal;
          if (hostStats.diskPercent != null) hostDiskPercent = hostStats.diskPercent;
          if (hostStats.netRxBytes != null) hostNetRx = hostStats.netRxBytes;
          if (hostStats.netTxBytes != null) hostNetTx = hostStats.netTxBytes;
          if (hostStats.memTotal != null) hostMemTotal = hostStats.memTotal;
          if (hostStats.memUsed != null) hostMemUsed = hostStats.memUsed;
          if (hostStats.memPercent != null) hostMemPercent = hostStats.memPercent;
        }
      } catch (e) {
        console.warn(`[collect] SSH host stats failed for ${worker.name}, using Podman-only data:`, e);
      }
    }

    await db.insert(workerMetrics).values({
      id: uuidv4(),
      workerId: params.id,
      collectedAt: now,
      cpuPercent: hostCpu,
      memUsageBytes: hostMemUsed,
      memLimitBytes: hostMemTotal,
      memPercent: hostMemPercent,
      diskUsageBytes: diskUsage,
      diskLimitBytes: hostDiskLimit,
      diskPercent: hostDiskPercent,
      netRxBytes: hostNetRx,
      netTxBytes: hostNetTx,
      containersRunning: store.containerStore?.running ?? null,
      containersTotal: store.containerStore?.number ?? null,
      imagesCount: store.imageStore?.number ?? null,
      volumesCount: store.volumeStore?.number ?? null,
    });

    return json({ success: true, collected: true, status: pingStatus });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
