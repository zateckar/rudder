/**
 * Background metrics collection.
 * Polls containers and workers at a configurable interval.
 * Call startMetricsCollection() once at server startup (guarded by globalThis flag).
 */
import { db, sqlite } from '$lib/db';
import { containers, workers, containerMetrics, workerMetrics, workerPings, systemSettings, applications, users } from '$lib/db/schema';
import { eq, lt } from 'drizzle-orm';
import { getRestPodmanClient } from './podman-client';
import { createPodmanClient } from './podman';
import { getHostStats } from './host-metrics';
import { getHostStatsHttp } from './host-metrics-http';
import { evaluateAlerts } from './alerts';
import { reconcileAllWorkers } from './reconcile';
import { decryptField } from './encryption';

// Track which provisioning events have already been processed to avoid redundant discovery runs
const lastProcessedProvisioning = new Map<string, number>();

const DEFAULT_INTERVAL_SECONDS = 60;    // 1 minute
const DEFAULT_RETENTION_DAYS = 30;
const COLLECTION_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes — safety net if HTTP requests hang

async function getSettings(key: string, defaultValue: number, min: number, max: number): Promise<number> {
  try {
    const row = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).get();
    if (row) {
      const val = parseInt(row.value);
      if (val >= min && val <= max) return val;
    }
  } catch {}
  return defaultValue;
}

async function getIntervalMs(): Promise<number> {
  return (await getSettings('metrics_interval_seconds', DEFAULT_INTERVAL_SECONDS, 10, 3600)) * 1000;
}

async function getRetentionDays(): Promise<number> {
  return getSettings('metrics_retention_days', DEFAULT_RETENTION_DAYS, 1, 365);
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
    if (worker.status !== 'online') continue;
    if (!byWorker.has(worker.id)) byWorker.set(worker.id, { worker, containers: [] });
    byWorker.get(worker.id)!.containers.push(container);
  }

  for (const [, { worker, containers: workerContainers }] of byWorker) {
    let client;
    try {
      client = getRestPodmanClient(worker);
    } catch (e) {
      console.error(`[metrics] Failed to create client for ${worker.name}:`, (e as any).message || e);
      continue;
    }

    // Fetch all Podman containers in one call — this is the source of truth
    let podmanContainers: any[] = [];
    try {
      podmanContainers = await client.listContainers(true);
      console.log(`[metrics] ${worker.name}: Podman has ${podmanContainers.length} containers, DB has ${workerContainers.length}`);
    } catch (e) {
      console.error(`[metrics] Failed to list containers for ${worker.name}:`, (e as any).message || e);
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

      if (!podmanState) {
        console.warn(`[metrics] ${worker.name}: container ${container.name} (${container.containerId.slice(0, 12)}) not found in Podman — marking missing`);
      }

      try {
        if (realStatus !== dbStatus) {
          await db.update(containers)
            .set({ status: realStatus, updatedAt: now })
            .where(eq(containers.id, container.id));
        }
      } catch (e) {
        console.error(`[metrics] Failed to update status for container ${container.name}:`, (e as any).message || e);
      }

      // Only collect metrics for running containers
      if (realStatus !== 'running') continue;

      try {
        const raw = await client.getContainerStats(container.containerId) as any;

        let cpuPercent = 0;
        let memUsage = 0;
        let memLimit = 0;
        let memPercent = 0;
        let rxBytes = 0;
        let txBytes = 0;
        let blockRead = 0;
        let blockWrite = 0;

        if (raw && typeof raw === 'object') {
          if (raw.Stats && Array.isArray(raw.Stats) && raw.Stats.length > 0) {
            // Libpod format
            const stat = raw.Stats[0];
            cpuPercent = stat.CPU ?? stat.CPUPerc ?? 0;
            memUsage = stat.MemUsage ?? 0;
            memLimit = stat.MemLimit ?? 0;
            memPercent = stat.MemPerc ?? (memLimit > 0 ? (memUsage / memLimit) * 100 : 0);
            rxBytes = stat.NetInput ?? 0;
            txBytes = stat.NetOutput ?? 0;
            blockRead = stat.BlockInput ?? 0;
            blockWrite = stat.BlockOutput ?? 0;
          } else {
            // Docker format
            const cpuUsage = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
            const preCpuUsage = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
            const systemCpu = raw.cpu_stats?.system_cpu_usage ?? 0;
            const preSystemCpu = raw.precpu_stats?.system_cpu_usage ?? 0;
            
            const cpuDelta = cpuUsage - preCpuUsage;
            const systemDelta = systemCpu - preSystemCpu;
            const numCpus = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
            
            cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

            memUsage = raw.memory_stats?.usage ?? 0;
            memLimit = raw.memory_stats?.limit ?? 0;
            memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

            if (raw.networks) {
              for (const iface of Object.values(raw.networks as Record<string, any>)) {
                rxBytes += iface.rx_bytes ?? 0;
                txBytes += iface.tx_bytes ?? 0;
              }
            }

            if (raw.blkio_stats?.io_service_bytes_recursive) {
              for (const entry of raw.blkio_stats.io_service_bytes_recursive) {
                if (entry.op === 'Read' || entry.op === 'read') blockRead += entry.value;
                if (entry.op === 'Write' || entry.op === 'write') blockWrite += entry.value;
              }
            }
          }
        }

        await db.insert(containerMetrics).values({
          id: crypto.randomUUID(),
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
        console.error(`[metrics] Failed to collect stats for container ${container.name}:`, (e as any).message || e);
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
          clientKey: decryptField(worker.podmanClientKey),
        });
        const ok = await client.ping();
        if (ok) {
          pingStatus = 'online';
          try { sysInfo = await client.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name}:`, (e as any).message || e); }
          try { systemDf = await client.systemDf(); } catch (e) { console.error(`[metrics] systemDf() failed for ${worker.name}:`, (e as any).message || e); }
        }
        client.destroy();
      } else if (worker.podmanApiUrl) {
        // Dev/local mode — no mTLS
        const client = createPodmanClient({ apiUrl: worker.podmanApiUrl });
        const ok = await client.ping();
        if (ok) {
          pingStatus = 'online';
          try { sysInfo = await client.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name}:`, (e as any).message || e); }
          try { systemDf = await client.systemDf(); } catch (e) { console.error(`[metrics] systemDf() failed for ${worker.name}:`, (e as any).message || e); }
        }
        client.destroy();
      }

      const latencyMs = Date.now() - start;

      // Store ping
      await db.insert(workerPings).values({
        id: crypto.randomUUID(),
        workerId: worker.id,
        pingedAt: now,
        status: pingStatus,
        latencyMs,
        error: pingStatus !== 'online' ? 'Unreachable' : null,
      });

      const previousStatus = worker.status;

      // Update worker status
      await db.update(workers).set({
        status: pingStatus,
        lastSeenAt: pingStatus === 'online' ? now : worker.lastSeenAt,
      }).where(eq(workers.id, worker.id));

      // Run app discovery when worker is online and recently provisioned
      if (pingStatus === 'online' && worker.provisionedAt) {
        const provTime = new Date(worker.provisionedAt).getTime();
        const nowTime = now.getTime();
        const recentlyProvisioned = (nowTime - provTime) < 3600000; // Within last hour

        if (recentlyProvisioned && lastProcessedProvisioning.get(worker.id) !== provTime) {
          console.log(`[metrics] Worker ${worker.name} was recently provisioned - running app discovery`);
          try {
            const { discoverApplicationsOnWorker } = await import('./app-discovery');
            // Find an admin user to attribute discovered resources to
            const adminUser = await db.select().from(users).where(eq(users.role, 'admin')).limit(1).get();
            const discoveryUserId = adminUser?.id ?? null;
            const results = await discoverApplicationsOnWorker(worker.id, discoveryUserId);
            console.log(
              `[metrics] Discovery complete: ${results.appsDiscovered} apps, ` +
              `${results.teamsCreated} teams, ${results.stacksCreated} stacks`
            );
            // Mark this provisioning as processed
            lastProcessedProvisioning.set(worker.id, provTime);
          } catch (e: any) {
            console.error(`[metrics] App discovery failed for ${worker.name}:`, e.message);
          }
        }
      }

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
      let updatesPending: number | null = null;
      let updatesSecurity: number | null = null;
      let rebootRequired: number | null = null;

      // Prefer HTTP metrics endpoint (installed during provisioning)
      // Fall back to SSH for workers not yet re-provisioned
      if (worker.baseDomain && worker.podmanCaCert) {
        try {
          const httpStats = await getHostStatsHttp(worker as any);
          if (httpStats) {
            if (httpStats.cpuPercent != null) hostCpu = httpStats.cpuPercent;
            if (httpStats.diskTotal != null) hostDiskLimit = httpStats.diskTotal;
            if (httpStats.diskPercent != null) hostDiskPercent = httpStats.diskPercent;
            if (httpStats.netRxBytes != null) hostNetRx = httpStats.netRxBytes;
            if (httpStats.netTxBytes != null) hostNetTx = httpStats.netTxBytes;
            if (httpStats.memTotal != null) hostMemTotal = httpStats.memTotal;
            if (httpStats.memUsed != null) hostMemUsed = httpStats.memUsed;
            if (httpStats.memPercent != null) hostMemPercent = httpStats.memPercent;
            // Left null when the worker did not report them, so "never
            // scanned" stays distinguishable from "nothing pending".
            updatesPending = httpStats.updatesPending ?? null;
            updatesSecurity = httpStats.updatesSecurity ?? null;
            rebootRequired = httpStats.rebootRequired ?? null;
          }
        } catch (e) {
          console.warn(`[metrics] HTTP host stats failed for ${worker.name}:`, (e as any).message || e);
        }
      }

      await db.insert(workerMetrics).values({
        id: crypto.randomUUID(),
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
        updatesPending,
        updatesSecurity,
        rebootRequired,
      });
    } catch (e) {
      console.error(`[metrics] Failed to collect metrics for worker ${worker.name}:`, (e as any).message || e);
    }
  }
}

// ── Prune old data ──────────────────────────────────────────────────────────────

/**
 * Delete rows older than the retention window.
 * For data older than 7 days, keep only 1 sample per hour (downsampling)
 * to preserve trending ability while dramatically reducing storage.
 */
async function pruneOldData(): Promise<void> {
  const retentionDays = await getRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);

  // ── Raw retention: delete anything past the absolute retention window ──────
  try {
    await db.delete(workerPings).where(lt(workerPings.pingedAt, cutoff));
  } catch { /* table may not exist yet */ }
  try {
    await db.delete(workerMetrics).where(lt(workerMetrics.collectedAt, cutoff));
  } catch { /* table may not exist yet */ }
  try {
    await db.delete(containerMetrics).where(lt(containerMetrics.collectedAt, cutoff));
  } catch { /* table may not exist yet */ }

  // ── Downsampling: for data between 7 days ago and the retention cutoff,    ──
  // ── keep at most 1 row per hour per worker/container. This preserves        ──
  // ── historical trend visibility without keeping every 1-minute sample.      ──
  const downsampleCutoff = new Date(Date.now() - 7 * 86_400_000);
  const downsampleUnix = Math.floor(downsampleCutoff.getTime() / 1000);

  // Only downsample if the downsample window is still within the retention window
  if (downsampleCutoff <= cutoff) return;

  // ── Downsample worker_pings: keep 1 row per hour per worker ────────────────
  try {
    sqlite.run(`
      DELETE FROM worker_pings WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY worker_id, strftime('%Y-%m-%dT%H', pinged_at, 'unixepoch')
                   ORDER BY pinged_at DESC
                 ) AS rn
          FROM worker_pings
          WHERE pinged_at >= ${downsampleUnix}
            AND pinged_at < ${cutoffUnix}
        ) WHERE rn > 1
      )
    `);
  } catch (e) {
    console.error('[metrics] Failed to downsample worker_pings:', (e as any).message || e);
  }

  // ── Downsample worker_metrics: keep 1 row per hour per worker ──────────────
  try {
    sqlite.run(`
      DELETE FROM worker_metrics WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY worker_id, strftime('%Y-%m-%dT%H', collected_at, 'unixepoch')
                   ORDER BY collected_at DESC
                 ) AS rn
          FROM worker_metrics
          WHERE collected_at >= ${downsampleUnix}
            AND collected_at < ${cutoffUnix}
        ) WHERE rn > 1
      )
    `);
  } catch (e) {
    console.error('[metrics] Failed to downsample worker_metrics:', (e as any).message || e);
  }

  // ── Downsample container_metrics: keep 1 row per hour per container ────────
  try {
    sqlite.run(`
      DELETE FROM container_metrics WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY container_id, strftime('%Y-%m-%dT%H', collected_at, 'unixepoch')
                   ORDER BY collected_at DESC
                 ) AS rn
          FROM container_metrics
          WHERE collected_at >= ${downsampleUnix}
            AND collected_at < ${cutoffUnix}
        ) WHERE rn > 1
      )
    `);
  } catch (e) {
    console.error('[metrics] Failed to downsample container_metrics:', (e as any).message || e);
  }
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

  const results = await Promise.allSettled([
    collectContainerMetrics(),
    collectWorkerMetrics(),
  ]);
  const labels = ['collectContainerMetrics', 'collectWorkerMetrics'];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error(`[metrics] ${labels[i]} failed:`, (results[i] as PromiseRejectedResult).reason?.message || (results[i] as PromiseRejectedResult).reason);
    }
  }
  await pruneOldData();

  // Superseded containers kept for a fast rollback have to be cleaned up even
  // if the application is never deployed again. This loop is the only thing
  // that already runs on a timer against every worker, so it is where the
  // sweep lives rather than in a scheduler of its own.
  try {
    const { sweepExpiredGenerations } = await import('./deploy');
    const reaped = await sweepExpiredGenerations();
    if (reaped > 0) console.log(`[metrics] Reaped ${reaped} retained container(s)`);
  } catch (e) {
    console.error('[metrics] Generation sweep failed:', (e as any).message || e);
  }

  // Diff what should be running against what is. Read-only: the pass makes one
  // Podman call, `listContainers`, and has no path to a create, start, stop or
  // remove. `apply` stays false until the reports have been watched for a full
  // release cycle — the failure mode worth catching is a bug in desiredState that
  // makes a healthy fleet look wrong, and that should be found in a report.
  //
  // Runs after the metrics sweep so container statuses in the database are as
  // fresh as they get before the comparison reads them.
  try {
    const reports = await reconcileAllWorkers({ apply: false });
    const drifted = reports.filter((r) => !r.clean).length;
    if (drifted > 0) {
      console.log(`[metrics] Reconciliation found drift on ${drifted}/${reports.length} worker(s)`);
    }
  } catch (e) {
    console.error('[metrics] Reconciliation failed:', (e as any).message || e);
  }

  // Evaluate alert rules against freshly collected metrics
  try {
    await evaluateAlerts();
  } catch (e) {
    console.error('[metrics] Alert evaluation failed:', (e as any).message || e);
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
    await Promise.race([
      collectAll(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Collection timed out — possible hung HTTP request')), COLLECTION_TIMEOUT_MS)
      ),
    ]);
    console.log(`[metrics] Collection done in ${Date.now() - start}ms`);
  } catch (e) {
    console.error('[metrics] Collection failed:', (e as any).message || e);
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