/**
 * Background metrics collection.
 * Polls containers and workers at a configurable interval.
 * Call startMetricsCollection() once at server startup (guarded by globalThis flag).
 */
import { db } from '$lib/db';
import { containers, workers, containerMetrics, workerMetrics, workerPings, systemSettings } from '$lib/db/schema';
import { eq, lt } from 'drizzle-orm';
import { getRestPodmanClient } from './podman-client';
import { v4 as uuid } from 'uuid';
import { createPodmanClient, createSSHPodmanClient } from './podman';
import { getSSHKey, type SSHConnectionConfig } from './ssh';
import { getHostStats } from './host-metrics';
import { evaluateAlerts } from './alerts';

const DEFAULT_INTERVAL_SECONDS = 300;   // 5 minutes
const RETENTION_DAYS = 30;

async function getIntervalMs(): Promise<number> {
  try {
    const row = await db.select().from(systemSettings).where(eq(systemSettings.key, 'metrics_interval_seconds')).get();
    if (row) {
      const seconds = parseInt(row.value);
      if (seconds >= 10 && seconds <= 3600) return seconds * 1000;
    }
  } catch {}
  return DEFAULT_INTERVAL_SECONDS * 1000;
}

// ── Container metrics (existing logic) ─────────────────────────────────────────

async function collectContainerMetrics(): Promise<void> {
  const now = new Date();

  // Load all DB containers with their workers
  const allContainers = await db
    .select({ container: containers, worker: workers })
    .from(containers)
    .innerJoin(workers, eq(containers.workerId, workers.id))
    .all();

  // Group by worker to minimize API calls
  const byWorker = new Map<string, { worker: typeof workers.$inferSelect; containers: (typeof containers.$inferSelect)[] }>();
  for (const { container, worker } of allContainers) {
    if (!byWorker.has(worker.id)) byWorker.set(worker.id, { worker, containers: [] });
    byWorker.get(worker.id)!.containers.push(container);
  }

  for (const [, { worker, containers: workerContainers }] of byWorker) {
    let client;
    try {
      client = getRestPodmanClient(worker);
    } catch { continue; }

    // Fetch all Podman containers in one call — this is the source of truth
    let podmanContainers: any[] = [];
    try {
      podmanContainers = await client.listContainers(true);
    } catch (e) {
      console.error(`[metrics] Failed to list containers for ${worker.name}:`, e);
      client.destroy();
      continue;
    }

    // Build map by Podman container ID → state
    const podmanMap = new Map<string, { state: string; status: string }>();
    for (const pc of podmanContainers) {
      podmanMap.set(pc.Id, { state: pc.State, status: pc.Status });
    }

    for (const container of workerContainers) {
      const podmanState = podmanMap.get(container.containerId);

      // Sync DB status with Podman source of truth
      const realStatus = podmanState?.state || 'missing';
      const dbStatus = container.status;

      if (realStatus !== dbStatus) {
        await db.update(containers)
          .set({ status: realStatus, updatedAt: now })
          .where(eq(containers.id, container.id));
      }

      // Only collect metrics for running containers
      if (realStatus !== 'running') continue;

      try {
        const raw = await client.getContainerStats(container.containerId);

        const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
        const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
        const numCpus = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
        const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

        const memUsage = raw.memory_stats.usage ?? 0;
        const memLimit = raw.memory_stats.limit ?? 0;
        const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

        let rxBytes = 0, txBytes = 0;
        if (raw.networks) {
          for (const iface of Object.values(raw.networks)) {
            rxBytes += iface.rx_bytes ?? 0;
            txBytes += iface.tx_bytes ?? 0;
          }
        }

        let blockRead = 0, blockWrite = 0;
        if (raw.blkio_stats?.io_service_bytes_recursive) {
          for (const entry of raw.blkio_stats.io_service_bytes_recursive) {
            if (entry.op === 'Read') blockRead += entry.value;
            if (entry.op === 'Write') blockWrite += entry.value;
          }
        }

        await db.insert(containerMetrics).values({
          id: uuid(),
          containerId: container.id,
          collectedAt: now,
          cpuPercent: Math.round(cpuPercent * 100) / 100,
          memUsageBytes: memUsage,
          memLimitBytes: memLimit,
          memPercent: Math.round(memPercent * 100) / 100,
          netRxBytes: rxBytes,
          netTxBytes: txBytes,
          blockReadBytes: blockRead,
          blockWriteBytes: blockWrite,
        });
      } catch (e) {
        console.error(`[metrics] Failed to collect stats for container ${container.name}:`, e);
      }
    }

    client.destroy();
  }
}

// ── Worker metrics ──────────────────────────────────────────────────────────────

async function collectWorkerMetrics(): Promise<void> {
  const now = new Date();
  const allWorkers = await db.select().from(workers).all();

  for (const worker of allWorkers) {
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
          try { sysInfo = await client.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name}:`, e); }
          try { systemDf = await client.systemDf(); } catch (e) { console.error(`[metrics] systemDf() failed for ${worker.name}:`, e); }
        }
        client.destroy();
      } else if (worker.podmanApiUrl) {
        // Dev/local mode — no mTLS
        const client = createPodmanClient({ apiUrl: worker.podmanApiUrl });
        const ok = await client.ping();
        if (ok) {
          pingStatus = 'online';
          try { sysInfo = await client.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name}:`, e); }
          try { systemDf = await client.systemDf(); } catch (e) { console.error(`[metrics] systemDf() failed for ${worker.name}:`, e); }
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
            try { sysInfo = await sshClient.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name} (SSH):`, e); }
          }
          sshClient.destroy();
        }
      }

      const latencyMs = Date.now() - start;

      // Store ping
      await db.insert(workerPings).values({
        id: uuid(),
        workerId: worker.id,
        pingedAt: now,
        status: pingStatus,
        latencyMs,
        error: pingStatus !== 'online' ? 'Unreachable' : null,
      });

      // Update worker status
      await db.update(workers).set({
        status: pingStatus,
        lastSeenAt: pingStatus === 'online' ? now : worker.lastSeenAt,
      }).where(eq(workers.id, worker.id));

      if (pingStatus !== 'online' || !sysInfo) continue;

      // Extract Podman metrics
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

      // Collect host-level stats via SSH (CPU, disk, network) — fills gaps Podman API doesn't provide
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
            // Prefer SSH memory data if available (more accurate than Podman's)
            if (hostStats.memTotal != null) hostMemTotal = hostStats.memTotal;
            if (hostStats.memUsed != null) hostMemUsed = hostStats.memUsed;
            if (hostStats.memPercent != null) hostMemPercent = hostStats.memPercent;
          }
        } catch (e) {
          console.warn(`[metrics] SSH host stats failed for ${worker.name}, using Podman-only data:`, e);
        }
      }

      await db.insert(workerMetrics).values({
        id: uuid(),
        workerId: worker.id,
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
    } catch (e) {
      console.error(`[metrics] Failed to collect metrics for worker ${worker.name}:`, e);
    }
  }
}

// ── Prune old data ──────────────────────────────────────────────────────────────

async function pruneOldData(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  try {
    await db.delete(containerMetrics).where(lt(containerMetrics.collectedAt, cutoff));
  } catch { /* table may not exist yet */ }
  try {
    await db.delete(workerMetrics).where(lt(workerMetrics.collectedAt, cutoff));
  } catch { /* table may not exist yet */ }
  try {
    await db.delete(workerPings).where(lt(workerPings.pingedAt, cutoff));
  } catch { /* table may not exist yet */ }
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

async function collectAll(): Promise<void> {
  // Verify DB is ready before attempting collection
  try {
    await db.select().from(workers).limit(0).all();
  } catch {
    // Tables not created yet -- skip this cycle
    return;
  }

  await Promise.allSettled([
    collectContainerMetrics(),
    collectWorkerMetrics(),
  ]);
  await pruneOldData();

  // Evaluate alert rules against freshly collected metrics
  try {
    await evaluateAlerts();
  } catch (e) {
    console.error('[metrics] Alert evaluation failed:', e);
  }
}

let running = false;

async function runLoop(): Promise<void> {
  if (running) {
    console.log('[metrics] Previous collection still running, skipping');
    scheduleNext();
    return;
  }
  running = true;
  const start = Date.now();
  try {
    await collectAll();
    console.log(`[metrics] Collection done in ${Date.now() - start}ms`);
  } catch (e) {
    console.error('[metrics] Collection failed:', e);
  } finally {
    running = false;
  }
  scheduleNext();
}

function scheduleNext(): void {
  getIntervalMs().then((ms) => {
    console.log(`[metrics] Next collection in ${ms / 1000}s`);
    setTimeout(runLoop, ms);
  }).catch(() => {
    // Fallback if DB read fails
    setTimeout(runLoop, DEFAULT_INTERVAL_SECONDS * 1000);
  });
}

export function startMetricsCollection(): void {
  console.log('[metrics] Starting background collection');
  // Delay first run to allow DB initialization to complete
  setTimeout(runLoop, 5000);
}
