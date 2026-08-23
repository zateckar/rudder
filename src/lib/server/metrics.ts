/**
 * Background metrics collection.
 *
 * One cycle, one pass per worker. `startMetricsCollection()` is called once at
 * server startup (guarded by a globalThis flag in hooks.server.ts).
 *
 * ## Why this is shaped as a sweep
 *
 * It used to be three independent walks of the fleet — container metrics,
 * worker metrics, then reconciliation — each building its own
 * `getRestPodmanClient` and each awaiting one worker before starting the next.
 * That meant three mTLS handshakes and *two* `listContainers` calls per worker
 * per cycle, and, because every loop was `for … await`, a single unresponsive
 * worker held up the entire fleet for the Podman client's 30-second request
 * timeout. The four-minute `COLLECTION_TIMEOUT_MS` below exists to catch that.
 *
 * Now each worker is swept once — ping, info, disk usage, container list, and
 * every container's stats — behind one client, workers are swept concurrently,
 * and the container list is handed to reconciliation rather than fetched again.
 */
import { db, sqlite } from '$lib/db';
import { containers, workers, containerMetrics, workerMetrics, workerPings, systemSettings } from '$lib/db/schema';
import { eq, lt, inArray } from 'drizzle-orm';
import { getRestPodmanClient } from './podman-client';
import { getHostStatsHttp } from './host-metrics-http';
import { evaluateAlerts } from './alerts';
import { reconcileAllWorkers, toObserved, type ObservedContainer } from './reconcile';
import { mapWithConcurrency } from './concurrency';
import type { PodmanClient } from './podman';

const DEFAULT_INTERVAL_SECONDS = 60;    // 1 minute
const DEFAULT_RETENTION_DAYS = 30;
const COLLECTION_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes — safety net if HTTP requests hang

/**
 * How many workers to sweep at once.
 *
 * Workers share nothing, so this is bounded only by the control plane's own
 * sockets and event loop. Eight keeps a large fleet's cycle short without
 * opening an unbounded number of TLS connections at the instant the timer
 * fires.
 */
const WORKER_CONCURRENCY = 8;

/**
 * How many `getContainerStats` calls to have in flight against one worker.
 *
 * Deliberately lower than the worker fan-out: this multiplies with it, and the
 * ceiling that matters is the load put on a single worker's Podman API, which
 * is a socket-activated service on the machine running the applications.
 */
const STATS_CONCURRENCY = 4;

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

// ── One worker, one pass ─────────────────────────────────────────────────────

type Worker = typeof workers.$inferSelect;
type ContainerRow = typeof containers.$inferSelect;

/** A container metric row, ready to insert. */
type MetricValues = typeof containerMetrics.$inferInsert;

interface WorkerSweep {
  worker: Worker;
  status: 'online' | 'offline' | 'error';
  latencyMs: number;
  /** Every container Podman reports, in the shape reconciliation compares. */
  observed: ObservedContainer[];
  /** True when `observed` is what the worker actually said, not an empty stand-in. */
  observedIsReal: boolean;
  sysInfo: any;
  systemDf: any;
  /** Rows whose recorded status disagrees with Podman, keyed by the new status. */
  statusFixes: Map<string, string[]>;
  containerMetrics: MetricValues[];
}

function emptySweep(worker: Worker, status: WorkerSweep['status'], latencyMs: number): WorkerSweep {
  return {
    worker,
    status,
    latencyMs,
    observed: [],
    observedIsReal: false,
    sysInfo: null,
    systemDf: null,
    statusFixes: new Map(),
    containerMetrics: [],
  };
}

/**
 * Everything this cycle needs from one worker, over one client.
 *
 * Never throws: a worker that cannot be reached comes back as `offline` or
 * `error` with nothing collected, because one unreachable machine must not stop
 * the others being swept.
 */
async function sweepWorker(worker: Worker, rows: readonly ContainerRow[]): Promise<WorkerSweep> {
  const start = Date.now();

  if (!worker.podmanApiUrl) {
    return emptySweep(worker, 'offline', 0);
  }

  let client: PodmanClient;
  try {
    client = getRestPodmanClient(worker);
  } catch (e) {
    // No usable credentials. `error` rather than `offline`: the machine may well
    // be up — what is missing is a way to reach it that this deployment is
    // willing to use.
    console.error(`[metrics] Cannot reach ${worker.name}:`, (e as any).message || e);
    return emptySweep(worker, 'error', Date.now() - start);
  }

  try {
    const reachable = await client.ping();
    const latencyMs = Date.now() - start;
    if (!reachable) return emptySweep(worker, 'offline', latencyMs);

    const sweep = emptySweep(worker, 'online', latencyMs);
    sweep.observedIsReal = true;

    // Each of these is separately survivable — a worker whose `systemDf` fails
    // should still report its container states.
    try { sweep.sysInfo = await client.info(); } catch (e) { console.error(`[metrics] info() failed for ${worker.name}:`, (e as any).message || e); }
    try { sweep.systemDf = await client.systemDf(); } catch (e) { console.error(`[metrics] systemDf() failed for ${worker.name}:`, (e as any).message || e); }

    try {
      sweep.observed = (await client.listContainers(true)).map(toObserved);
    } catch (e) {
      console.error(`[metrics] Failed to list containers for ${worker.name}:`, (e as any).message || e);
      // Not a real observation, so reconciliation must not treat the empty list
      // as "every container has vanished" — see `observedIsReal`.
      sweep.observedIsReal = false;
      return sweep;
    }

    const byPodmanId = new Map(sweep.observed.map((c) => [c.id, c]));

    // Podman is the source of truth for status. Grouped rather than written per
    // container: one UPDATE per distinct status beats one per row.
    const running: ContainerRow[] = [];
    for (const row of rows) {
      const realStatus = byPodmanId.get(row.containerId)?.state ?? 'missing';
      if (realStatus !== row.status) {
        const bucket = sweep.statusFixes.get(realStatus) ?? [];
        bucket.push(row.id);
        sweep.statusFixes.set(realStatus, bucket);
      }
      if (realStatus === 'running') running.push(row);
    }

    const collectedAt = new Date();
    const stats = await mapWithConcurrency(
      running,
      STATS_CONCURRENCY,
      async (row): Promise<MetricValues | null> => {
        try {
          const raw = await client.getContainerStats(row.containerId);
          return { ...parseStats(raw), id: crypto.randomUUID(), containerId: row.id, collectedAt };
        } catch (e) {
          console.error(`[metrics] Failed to collect stats for container ${row.name}:`, (e as any).message || e);
          return null;
        }
      },
    );
    sweep.containerMetrics = stats.filter((s): s is MetricValues => s !== null);

    return sweep;
  } finally {
    client.destroy();
  }
}

/**
 * Normalise a stats response into the columns `container_metrics` stores.
 *
 * Podman answers in one of two shapes depending on which API surface handled
 * the call — its own `Stats` array, or Docker's nested counters. Both are
 * handled here rather than at the call site so the sweep stays readable.
 */
function parseStats(raw: any): Omit<MetricValues, 'id' | 'containerId' | 'collectedAt'> {
  let cpuPercent = 0;
  let memUsage = 0;
  let memLimit = 0;
  let memPercent = 0;
  let rxBytes = 0;
  let txBytes = 0;
  let blockRead = 0;
  let blockWrite = 0;

  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.Stats) && raw.Stats.length > 0) {
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
          rxBytes += (iface as any).rx_bytes ?? 0;
          txBytes += (iface as any).tx_bytes ?? 0;
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

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memUsageBytes: memUsage,
    memLimitBytes: memLimit,
    memPercent: Math.round(memPercent * 100) / 100,
    netRxBytes: rxBytes,
    netTxBytes: txBytes,
    blockReadBytes: blockRead,
    blockWriteBytes: blockWrite,
  };
}

// ── Writing a sweep down ─────────────────────────────────────────────────────

async function persistSweep(sweep: WorkerSweep, now: Date): Promise<void> {
  const { worker } = sweep;

  await db.insert(workerPings).values({
    id: crypto.randomUUID(),
    workerId: worker.id,
    pingedAt: now,
    status: sweep.status,
    latencyMs: sweep.latencyMs,
    error: sweep.status !== 'online' ? 'Unreachable' : null,
  });

  await db.update(workers).set({
    status: sweep.status,
    lastSeenAt: sweep.status === 'online' ? now : worker.lastSeenAt,
  }).where(eq(workers.id, worker.id));

  for (const [status, ids] of sweep.statusFixes) {
    try {
      await db.update(containers).set({ status, updatedAt: now }).where(inArray(containers.id, ids));
    } catch (e) {
      console.error(`[metrics] Failed to update container statuses on ${worker.name}:`, (e as any).message || e);
    }
  }

  if (sweep.containerMetrics.length > 0) {
    // One insert for the whole worker, not one per container.
    try {
      await db.insert(containerMetrics).values(sweep.containerMetrics);
    } catch (e) {
      console.error(`[metrics] Failed to record container metrics for ${worker.name}:`, (e as any).message || e);
    }
  }

  if (sweep.status !== 'online' || !sweep.sysInfo) return;

  // Discovery used to run here: a recently provisioned worker had its
  // containers walked, reverse-engineered into application records and written
  // to the database, with nobody asked. It existed because nothing reconciled,
  // so import had to guess at everything to be useful.
  //
  // Reconciliation now reports drift, and adoption is an operator decision made
  // on the worker's page. Rudder does not decide what it owns while the person
  // who provisioned a machine is looking somewhere else.

  const host = sweep.sysInfo.host || {};
  const store = sweep.sysInfo.store || {};
  const memTotal = host.memTotal || null;
  const memFree = host.memFree || null;
  const memUsed = memTotal && memFree ? memTotal - memFree : null;
  const memPercent = memTotal && memUsed ? Math.round((memUsed / memTotal) * 10000) / 100 : null;

  let diskUsage: number | null = null;
  if (sweep.systemDf) {
    const imagesSize = (sweep.systemDf.ImagesDiskUsage || []).reduce((s: number, i: any) => s + (i.Size || 0), 0);
    const containersSize = (sweep.systemDf.ContainersDiskUsage || []).reduce((s: number, c: any) => s + (c.Size || 0), 0);
    const volumesSize = (sweep.systemDf.VolumesDiskUsage || []).reduce((s: number, v: any) => s + (v.UsageData?.Size || 0), 0);
    diskUsage = imagesSize + containersSize + volumesSize;
  }

  // Host-level stats (CPU, disk, network) — the gaps the Podman API does not
  // report. Collected over the worker's own metrics endpoint, behind the same
  // mTLS as the Podman API.
  //
  // There used to be an SSH fallback here for workers provisioned before that
  // endpoint existed. It cannot work any more: SSH keys live in the browser
  // vault, not on the server, so no background timer can open a session. A
  // worker that reports nothing here leaves these null, which is the honest
  // answer — re-provision it to get the endpoint.
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
        // Left null when the worker did not report them, so "never scanned"
        // stays distinguishable from "nothing pending".
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
}

/**
 * Sweep every worker, write what came back, and return what reconciliation can
 * reuse.
 */
async function collectFleet(): Promise<Map<string, readonly ObservedContainer[]>> {
  const now = new Date();
  const allWorkers = await db.select().from(workers).all();
  if (allWorkers.length === 0) return new Map();

  // Every tracked container in one query, grouped in memory — this used to be a
  // join re-read per worker.
  const allRows = await db.select().from(containers).all();
  const rowsByWorker = new Map<string, ContainerRow[]>();
  for (const row of allRows) {
    if (!row.workerId) continue;
    const bucket = rowsByWorker.get(row.workerId) ?? [];
    bucket.push(row);
    rowsByWorker.set(row.workerId, bucket);
  }

  const sweeps = await mapWithConcurrency(allWorkers, WORKER_CONCURRENCY, async (worker) => {
    try {
      return await sweepWorker(worker, rowsByWorker.get(worker.id) ?? []);
    } catch (e) {
      console.error(`[metrics] Sweep failed for ${worker.name}:`, (e as any).message || e);
      return emptySweep(worker, 'error', 0);
    }
  });

  const observedByWorker = new Map<string, readonly ObservedContainer[]>();
  for (const sweep of sweeps) {
    try {
      await persistSweep(sweep, now);
    } catch (e) {
      console.error(`[metrics] Failed to record metrics for ${sweep.worker.name}:`, (e as any).message || e);
    }
    // Only a real listing is handed on. A worker whose list call failed must not
    // reconcile against an empty set, which would report every one of its
    // containers as missing.
    if (sweep.observedIsReal) observedByWorker.set(sweep.worker.id, sweep.observed);
  }

  return observedByWorker;
}

// ── Prune old data ──────────────────────────────────────────────────────────────

/**
 * Keep at most one row per hour per resource, for rows older than a week.
 *
 * Prepared once rather than per cycle, and bound rather than interpolated: the
 * values are internally derived integers so the previous string interpolation
 * was not injectable, but every other query in the codebase binds and there is
 * no reason for these three to be the exception.
 */
const DOWNSAMPLE = {
  worker_pings: 'worker_id, pinged_at',
  worker_metrics: 'worker_id, collected_at',
  container_metrics: 'container_id, collected_at',
} as const;

const downsampleStatements = new Map<string, ReturnType<typeof sqlite.prepare>>();

function downsampleStatement(table: keyof typeof DOWNSAMPLE) {
  const cached = downsampleStatements.get(table);
  if (cached) return cached;

  const [partition, timestamp] = DOWNSAMPLE[table].split(', ');
  const statement = sqlite.prepare(`
    DELETE FROM ${table} WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY ${partition}, strftime('%Y-%m-%dT%H', ${timestamp}, 'unixepoch')
                 ORDER BY ${timestamp} DESC
               ) AS rn
        FROM ${table}
        WHERE ${timestamp} >= ? AND ${timestamp} < ?
      ) WHERE rn > 1
    )
  `);
  downsampleStatements.set(table, statement);
  return statement;
}

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

  const downsampleCutoff = new Date(Date.now() - 7 * 86_400_000);
  const downsampleUnix = Math.floor(downsampleCutoff.getTime() / 1000);

  // Only downsample if the downsample window is still within the retention window
  if (downsampleCutoff <= cutoff) return;

  for (const table of Object.keys(DOWNSAMPLE) as Array<keyof typeof DOWNSAMPLE>) {
    try {
      downsampleStatement(table).run(downsampleUnix, cutoffUnix);
    } catch (e) {
      console.error(`[metrics] Failed to downsample ${table}:`, (e as any).message || e);
    }
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

  let observedByWorker = new Map<string, readonly ObservedContainer[]>();
  try {
    observedByWorker = await collectFleet();
  } catch (e) {
    console.error('[metrics] Fleet sweep failed:', (e as any).message || e);
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

  // Diff what should be running against what is. Read-only: the pass makes no
  // Podman call of its own now — it is handed the container list the sweep
  // above already fetched — and has no path to a create, start, stop or remove.
  // `apply` stays false until the reports have been watched for a full release
  // cycle: the failure mode worth catching is a bug in desiredState that makes
  // a healthy fleet look wrong, and that should be found in a report.
  //
  // Runs after the sweep so container statuses in the database are as fresh as
  // they get before the comparison reads them.
  try {
    const reports = await reconcileAllWorkers({ apply: false, observedByWorker });
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
    console.warn('[metrics] Previous collection still running, skipping this cycle');
    scheduleNext();
    return;
  }
  running = true;
  const start = Date.now();

  // `Promise.race` abandons the loser, it does not cancel it, so a timed-out
  // collection is still running when the race rejects. Clearing `running` at
  // that point defeats the guard above and lets the next cycle start alongside
  // it — two concurrent sweeps selecting the same draining rows, two reconcile
  // passes racing the same upsert. So the flag is released by the collection
  // itself, whenever it actually finishes, and the timeout only reports.
  const collection = collectAll();
  let timedOut = false;

  collection
    .catch(() => { /* reported below, or by the race */ })
    .finally(() => {
      running = false;
      if (timedOut) {
        console.warn(
          `[metrics] The collection that timed out finished after ${Date.now() - start}ms; ` +
            `cycles were skipped until it did.`,
        );
      }
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      collection,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Collection timed out — possible hung HTTP request'));
        }, COLLECTION_TIMEOUT_MS);
      }),
    ]);
    console.log(`[metrics] Cycle finished in ${Date.now() - start}ms`);
  } catch (e) {
    console.error('[metrics] Collection failed:', (e as any).message || e);
  } finally {
    // Otherwise every fast cycle leaves a four-minute timer pending.
    clearTimeout(timer);
  }
  scheduleNext();
}

function scheduleNext(): void {
  getIntervalMs().then((ms) => {
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
