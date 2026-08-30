/**
 * The last thing the metrics sweep learned about each worker, kept in memory.
 *
 * `POST /api/workers/[id]/info` used to ask the worker itself, every time it
 * was called: `ping()`, then `info()`, `systemDf()`, `getPlatformVersions()`
 * (three container inspects of its own) and the host metrics endpoint. The
 * worker page calls it on load and on a poll, so an operator clicking a worker
 * that had just gone down waited for each of those to reach its own timeout in
 * turn — the better part of a minute of a hung page, to be told the thing the
 * `workers.status` column already said.
 *
 * The sweep asks the same questions of every worker on a timer anyway, keeps
 * the answers it derives numbers from, and throws the documents away. This is
 * where they go instead. The endpoint reads from here when the entry is fresh
 * and only goes to the worker when it is not, so the common case is a memory
 * read and the fleet is asked once per cycle rather than once per page.
 *
 * In memory and not in the database on purpose: this is a cache of a live
 * machine's state, worthless after a restart, and `worker_metrics` already
 * holds the parts worth keeping.
 */

import type { HostStats } from './host-metrics';

export interface WorkerInfoSnapshot {
  /** Podman's `info`, whole. */
  sysInfo: unknown;
  /** Podman's `system df`, whole. */
  systemDf: unknown;
  /** The worker's own metrics endpoint, when it has one. */
  hostStats: HostStats | null;
  status: 'online' | 'offline' | 'error';
  latencyMs: number;
  at: number;
}

const snapshots = new Map<string, WorkerInfoSnapshot>();

export function publishWorkerInfo(
  workerId: string,
  snapshot: Omit<WorkerInfoSnapshot, 'at'>,
): void {
  // `Date.now()` rather than a passed-in clock: freshness is judged against the
  // reader's clock and both run in this process.
  snapshots.set(workerId, { ...snapshot, at: Date.now() });
}

/**
 * The snapshot for a worker, if it is younger than `maxAgeMs`.
 *
 * Age is the caller's judgement because it depends on what they are willing to
 * show. The endpoint allows a couple of collection intervals: long enough that
 * an ordinary page load always hits, short enough that a worker which went down
 * two cycles ago is not still reported as up.
 */
export function readWorkerInfo(workerId: string, maxAgeMs: number): WorkerInfoSnapshot | null {
  const snapshot = snapshots.get(workerId);
  if (!snapshot) return null;
  return Date.now() - snapshot.at <= maxAgeMs ? snapshot : null;
}

/** Drop a worker's entry. For deletion, so a removed worker leaves nothing behind. */
export function forgetWorkerInfo(workerId: string): void {
  snapshots.delete(workerId);
}

// ── Platform versions ────────────────────────────────────────────────────────
//
// Kept separately because they are not part of the sweep and are far more
// stable than the rest of this: Traefik and CrowdSec versions change when a
// worker is re-provisioned, not between two page loads. Three container
// inspects for something that has not moved in a month is the whole cost being
// avoided here, so this TTL is generous where the one above is not.

interface PlatformEntry {
  value: unknown;
  at: number;
}

const platforms = new Map<string, PlatformEntry>();

export const PLATFORM_TTL_MS = 15 * 60 * 1000;

export function readPlatformVersions(workerId: string): unknown | null {
  const entry = platforms.get(workerId);
  if (!entry) return null;
  return Date.now() - entry.at <= PLATFORM_TTL_MS ? entry.value : null;
}

export function publishPlatformVersions(workerId: string, value: unknown): void {
  platforms.set(workerId, { value, at: Date.now() });
}
