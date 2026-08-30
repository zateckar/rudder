/**
 * Simple in-memory locking mechanism for preventing concurrent operations.
 * Uses a Map with TTL-based cleanup to prevent memory leaks.
 */

interface LockEntry {
  acquiredAt: Date;
  operation: string;
  holder: string;
  /**
   * How long this holder is allowed to run before the lock is considered
   * abandoned. Recorded per entry because it is a property of the operation
   * being protected, not of whoever asks next: a deploy legitimately runs for
   * longer than the default, and judging its staleness by the default — or by
   * the ttl of the caller that happens to be contending — releases the lock out
   * from under it and lets a second one run concurrently, which is the whole
   * thing the lock exists to prevent.
   */
  ttlMs: number;
}

const locks = new Map<string, LockEntry>();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isStale(entry: LockEntry, now: number): boolean {
  return now - entry.acquiredAt.getTime() > entry.ttlMs;
}

function cleanupExpiredLocks(): void {
  const now = Date.now();
  for (const [key, entry] of locks.entries()) {
    if (isStale(entry, now)) {
      console.warn(`Lock ${key} expired, releasing (held by ${entry.holder} for ${entry.operation})`);
      locks.delete(key);
    }
  }
}

setInterval(cleanupExpiredLocks, 60 * 1000).unref();

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
  const ttl = options.ttlMs || DEFAULT_TTL_MS;

  const existing = locks.get(key);
  if (existing) {
    const now = Date.now();
    // Judged against the *holder's* ttl, not this caller's.
    if (!isStale(existing, now)) {
      const age = now - existing.acquiredAt.getTime();
      throw new LockError(
        `Resource "${key}" is locked by ${existing.holder} for ${existing.operation} (${Math.round(age / 1000)}s ago)`
      );
    }
    console.warn(`Lock ${key} expired during acquisition, proceeding`);
  }

  locks.set(key, {
    acquiredAt: new Date(),
    operation: options.operation,
    holder,
    ttlMs: ttl,
  });

  try {
    return await fn();
  } finally {
    const current = locks.get(key);
    if (current && current.holder === holder) {
      locks.delete(key);
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
 * How long a volume operation may hold the worker lock before it is presumed
 * abandoned.
 *
 * The default ten minutes is sized for a deploy and is far too short for these.
 * A restore streams an upload of arbitrary size from the client's browser and a
 * copy is a `cp -a` of an arbitrarily large volume; both routinely outlast it, and
 * both talk to Podman with `timeoutMs: null` because being idle for a long time is
 * what they are supposed to do. Once `isStale` says the lock is abandoned, a
 * webhook-triggered deploy acquires the same key and recreates containers onto the
 * volume mid-extraction — precisely the interleaving the lock was extended to
 * cover, and silently, because the operation's own `finally` then finds a
 * different holder and does not even release it.
 *
 * Six hours. A lock is in-memory and dies with the process, so the only thing
 * this bounds is a genuinely hung operation inside a live one; being generous
 * costs nothing that a restart does not already fix.
 */
export const VOLUME_OP_TTL_MS = 6 * 60 * 60 * 1000;

export function isLocked(key: string): boolean {
  const entry = locks.get(key);
  if (!entry) return false;
  return !isStale(entry, Date.now());
}

/**
 * There is deliberately no `releaseLock`.
 *
 * There was one, taking an optional `holder`; called without it — which is how
 * an optional argument gets called — it deleted whoever's lock was there, which
 * is the one thing no caller is entitled to do. Nothing used it, so it was a
 * loaded gun with no purpose rather than a bug.
 *
 * `withLock`'s `finally` is the only release path, and it checks the holder
 * before deleting. If something ever genuinely needs to break a lock from
 * outside, it should say so in its name and log who it took it from.
 */
