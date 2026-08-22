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

export function isLocked(key: string): boolean {
  const entry = locks.get(key);
  if (!entry) return false;
  return !isStale(entry, Date.now());
}

export function releaseLock(key: string, holder?: string): boolean {
  const entry = locks.get(key);
  if (!entry) return false;
  if (holder && entry.holder !== holder) return false;
  locks.delete(key);
  return true;
}
