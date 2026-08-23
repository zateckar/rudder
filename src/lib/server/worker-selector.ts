/**
 * Worker selection based on available resources.
 * Picks the worker with the most available CPU, memory, and disk capacity.
 * Returns null if all workers are over the utilization threshold (>85%).
 */
import { db, safeWorkerColumns, toSafeWorker, type SafeWorker } from '$lib/db';
import { workers, workerMetrics, workerPings } from '$lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

const UTILIZATION_THRESHOLD = 85; // percent
const METRICS_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export interface WorkerResourceInfo {
  /**
   * Reduced to what a browser may see.
   *
   * Every one of these lists is rendered on a page — the dashboard's capacity
   * panel and the new-application worker picker — and both used to serialise
   * the whole row, so an admin loading the dashboard received every worker's
   * config token, OIDC client secret, session key, bouncer key and Podman
   * client key. Encrypted at rest, so ciphertext rather than plaintext, but
   * there is no reason for any of it to leave the server.
   *
   * `selectWorker` keeps the full row on its own `worker` field: it names a
   * deploy target and the caller needs the credentials to reach it.
   */
  worker: SafeWorker;
  cpuPercent: number | null;
  memPercent: number | null;
  diskUsageBytes: number | null;
  containersRunning: number | null;
  score: number;
}

export interface WorkerSelectionResult {
  worker: typeof workers.$inferSelect;
  resources: WorkerResourceInfo;
  allWorkerResources: WorkerResourceInfo[];
}

/**
 * Get the latest worker metrics for each worker from the last 30 minutes.
 */
async function getLatestMetrics(): Promise<Map<string, typeof workerMetrics.$inferSelect>> {
  const since = new Date(Date.now() - METRICS_WINDOW_MS);
  const recentMetrics = await db
    .select()
    .from(workerMetrics)
    .where(gte(workerMetrics.collectedAt, since))
    .orderBy(desc(workerMetrics.collectedAt))
    .all();

  const latest = new Map<string, typeof workerMetrics.$inferSelect>();
  for (const m of recentMetrics) {
    if (!latest.has(m.workerId)) {
      latest.set(m.workerId, m);
    }
  }
  return latest;
}

/**
 * Get the set of worker IDs that are currently online (last ping was successful).
 */
async function getOnlineWorkerIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - METRICS_WINDOW_MS);
  const recentPings = await db
    .select()
    .from(workerPings)
    .where(gte(workerPings.pingedAt, since))
    .orderBy(desc(workerPings.pingedAt))
    .all();

  const onlineIds = new Set<string>();
  for (const p of recentPings) {
    if (!onlineIds.has(p.workerId) && p.status === 'online') {
      onlineIds.add(p.workerId);
    }
  }
  return onlineIds;
}

/**
 * Score a worker's resource availability.
 * Higher score = more resources available.
 * Returns 0 if any resource is over the threshold.
 */
function scoreWorker(metrics: typeof workerMetrics.$inferSelect | undefined): number {
  if (!metrics) return 50; // No metrics yet — assume moderate availability so newly provisioned workers are eligible

  const cpuAvail = metrics.cpuPercent != null ? 100 - metrics.cpuPercent : 50;
  const memAvail = metrics.memPercent != null ? 100 - metrics.memPercent : 50;
  const diskAvail = metrics.diskPercent != null ? 100 - metrics.diskPercent : 80;

  if (cpuAvail < (100 - UTILIZATION_THRESHOLD) || memAvail < (100 - UTILIZATION_THRESHOLD) || diskAvail < (100 - UTILIZATION_THRESHOLD)) {
    return 0;
  }

  return cpuAvail * 0.4 + memAvail * 0.4 + diskAvail * 0.2;
}

/**
 * Select the best worker for deploying a new application.
 * Only considers online workers with baseDomain configured.
 * Returns null if no workers have sufficient resources.
 */
export async function selectWorker(): Promise<WorkerSelectionResult | null> {
  const allWorkers = await db
    .select()
    .from(workers)
    .all();

  const eligibleWorkers = allWorkers.filter(w => w.baseDomain);
  if (eligibleWorkers.length === 0) return null;

  const onlineIds = await getOnlineWorkerIds();
  const latestMetrics = await getLatestMetrics();

  // Include workers that are either pinged online recently OR have status='online' (e.g. just provisioned)
  const resources: WorkerResourceInfo[] = eligibleWorkers
    .filter(w => onlineIds.has(w.id) || w.status === 'online')
    .map(w => {
      const m = latestMetrics.get(w.id);
      return {
        worker: toSafeWorker(w),
        cpuPercent: m?.cpuPercent ?? null,
        memPercent: m?.memPercent ?? null,
        diskUsageBytes: m?.diskUsageBytes ?? null,
        containersRunning: m?.containersRunning ?? null,
        score: scoreWorker(m),
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = resources[0];
  if (!best || best.score <= 0) return null;

  // The winner is returned in full: this names a deploy target, and reaching it
  // needs the Podman credentials the resource lists deliberately drop. Callers
  // that hand it to a page are responsible for stripping it again.
  const fullRows = new Map(eligibleWorkers.map((w) => [w.id, w]));

  return {
    worker: fullRows.get(best.worker.id)!,
    resources: best,
    allWorkerResources: resources,
  };
}

/**
 * Get resource info for all online workers (for dashboard display).
 */
export async function getAllWorkerResources(): Promise<WorkerResourceInfo[]> {
  // Only the safe columns are needed here — nothing on this path reaches a
  // worker, it only describes one — so they are the only ones selected.
  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();
  const onlineIds = await getOnlineWorkerIds();
  const latestMetrics = await getLatestMetrics();

  return allWorkers.map(w => {
    const m = latestMetrics.get(w.id);
    return {
      worker: w,
      cpuPercent: m?.cpuPercent ?? null,
      memPercent: m?.memPercent ?? null,
      diskUsageBytes: m?.diskUsageBytes ?? null,
      containersRunning: m?.containersRunning ?? null,
      score: scoreWorker(m),
    };
  });
}

/**
 * Get all eligible workers (online with baseDomain) for the worker selector dropdown.
 */
export async function getAllEligibleWorkers(): Promise<WorkerResourceInfo[]> {
  const allWorkers = await db.select().from(workers).all();
  const eligibleWorkers = allWorkers.filter(w => w.baseDomain);
  const onlineIds = await getOnlineWorkerIds();
  const latestMetrics = await getLatestMetrics();

  return eligibleWorkers
    .filter(w => onlineIds.has(w.id) || w.status === 'online')
    .map(w => {
      const m = latestMetrics.get(w.id);
      return {
        worker: toSafeWorker(w),
        cpuPercent: m?.cpuPercent ?? null,
        memPercent: m?.memPercent ?? null,
        diskUsageBytes: m?.diskUsageBytes ?? null,
        containersRunning: m?.containersRunning ?? null,
        score: scoreWorker(m),
      };
    })
    .sort((a, b) => b.score - a.score);
}
