/**
 * In-process fixed-window rate limiter.
 *
 * Rudder runs as a single Node/Bun process backed by one SQLite file, so an
 * in-memory counter is sufficient and avoids a round trip per attempt.  If the
 * app is ever scaled horizontally this needs to move to shared storage.
 */

interface Bucket {
  count: number;
  resetAt: number;
  /** Set once a bucket trips, so the block outlives the counting window. */
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now && b.blockedUntil <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when blocked. */
  retryAfterSeconds: number;
  remaining: number;
}

export interface RateLimitOptions {
  /** Attempts permitted per window. */
  limit: number;
  /** Counting window in milliseconds. */
  windowMs: number;
  /** How long to lock out once the limit is exceeded. Defaults to windowMs. */
  blockMs?: number;
}

/**
 * Record an attempt against `key`.  Call this before doing the expensive work
 * (e.g. a bcrypt comparison) so a flood is rejected cheaply.
 */
export function consume(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const blockMs = opts.blockMs ?? opts.windowMs;
  let bucket = buckets.get(key);

  if (bucket && bucket.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
      remaining: 0,
    };
  }

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + opts.windowMs, blockedUntil: 0 };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > opts.limit) {
    bucket.blockedUntil = now + blockMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(blockMs / 1000),
      remaining: 0,
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: opts.limit - bucket.count,
  };
}

/** Clear a key's counter, e.g. after a successful login. */
export function reset(key: string): void {
  buckets.delete(key);
}
