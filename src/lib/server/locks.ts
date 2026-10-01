/**
 * Simple in-memory locking mechanism for preventing concurrent operations.
 * A live callback owns its lock until its finally block runs. Timeouts cannot
 * cancel callbacks and must never admit another mutation alongside them.
 */

interface LockEntry {
  acquiredAt: Date;
  operation: string;
  holder: string;
  /**
   * Diagnostic threshold only. A slow or hung callback still owns the lock;
   * process restart releases in-memory ownership after callbacks are gone.
   */
  ttlMs: number;
}

const locks = new Map<string, LockEntry>();
const mutationEpochs = new Map<string, number>();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export interface LockOptions {
  operation: string;
  holder?: string;
  ttlMs?: number;
}

export async function withLock<T>(
  key: string,
  options: LockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const holder = options.holder || process.pid.toString();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;

  const existing = locks.get(key);
  if (existing) {
    const now = Date.now();
    const age = now - existing.acquiredAt.getTime();
    throw new LockError(
      `Resource "${key}" is locked by ${existing.holder} for ${existing.operation} (${Math.round(age / 1000)}s ago${age > existing.ttlMs ? ', exceeding its expected duration' : ''})`
    );
  }

  const entry: LockEntry = {
    acquiredAt: new Date(),
    operation: options.operation,
    holder,
    ttlMs: ttl,
  };
  locks.set(key, entry);
  mutationEpochs.set(key, (mutationEpochs.get(key) ?? 0) + 1);

  try {
    return await fn();
  } finally {
    const current = locks.get(key);
    if (current === entry) {
      locks.delete(key);
      mutationEpochs.set(key, (mutationEpochs.get(key) ?? 0) + 1);
    }
  }
}

/**
 * Serialize everything that mutates one worker's containers or their storage.
 *
 * Keyed on the worker, not the application, because the contended resources are
 * shared: `reservedPortsForWorker` reads the `containers` rows, and a deploy
 * does not write one until well after it has allocated, so two deploys of
 * *different* applications overlapping on one worker can be handed the same host
 * port and the second container fails to bind. Two deploys of the *same*
 * application additionally compute the same `nextGeneration` from the same
 * snapshot and collide on the container name.
 *
 * Not hypothetical: `/api/applications/[id]/webhook/trigger` runs a full deploy
 * synchronously and has no rate limit, so an ordinary CI retry is enough.
 *
 * It lives here rather than in `deploy.ts`, where it started, because deploys are
 * no longer the only thing that needs it: restoring or copying a volume must not
 * run while a deploy is recreating the containers mounting it.
 */
export function workerDeployLock(workerId: string): string {
  return `deploy:worker:${workerId}`;
}

/**
 * Expected duration of a volume operation, used in contention diagnostics.
 *
 * The default ten minutes is sized for a deploy and is far too short for these.
 * A restore streams an upload of arbitrary size from the client's browser and a
 * copy is a `cp -a` of an arbitrarily large volume; both routinely outlast it, and
 * both talk to Podman with `timeoutMs: null` because being idle for a long time is
 * what they are supposed to do. Ownership therefore lasts until completion,
 * even beyond this diagnostic threshold.
 *
 * Six hours. A lock is in-memory and dies with the process, so the only thing
 * this describes is a slow operation inside a live process.
 */
export const VOLUME_OP_TTL_MS = 6 * 60 * 60 * 1000;

export function isLocked(key: string): boolean {
  return locks.has(key);
}

/** Invalidates asynchronous reads on both entry to and exit from a mutation. */
export function workerMutationEpoch(workerId: string): number {
  return mutationEpochs.get(workerDeployLock(workerId)) ?? 0;
}

/** Check and commit synchronously; an await between them would reintroduce a race. */
export function workerSnapshotIsCurrent(workerId: string, epoch: number): boolean {
  return !isLocked(workerDeployLock(workerId)) && workerMutationEpoch(workerId) === epoch;
}

/**
 * There is deliberately no `releaseLock`.
 *
 * There was one, taking an optional `holder`; called without it — which is how
 * an optional argument gets called — it deleted whoever's lock was there, which
 * is the one thing no caller is entitled to do. Nothing used it, so it was a
 * loaded gun with no purpose rather than a bug.
 *
 * `withLock`'s `finally` is the only release path, and it checks acquisition identity
 * before deleting. If something ever genuinely needs to break a lock from
 * outside, it should say so in its name and log who it took it from.
 */
