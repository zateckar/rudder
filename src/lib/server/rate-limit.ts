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

/** Warn about a misconfigured proxy once per process, not once per request. */
let warnedAboutAddress = false;

/**
 * Whether `getClientAddress()` actually distinguishes one caller from another.
 *
 * `adapter-node` only reads the client address out of a forwarded header when
 * `ADDRESS_HEADER` names one; otherwise it reports the immediate peer, which
 * behind a reverse proxy is the proxy. Every caller then shares one bucket, and
 * a per-IP limit becomes an installation-wide one: twenty bad passwords from
 * anywhere lock out every user for the block period. That is a worse failure
 * than having no per-IP limit at all, and it looks like a working limit from the
 * outside, so it is detected rather than left to be discovered during an
 * incident.
 *
 * Decided from the environment alone, never from the request. The obvious test —
 * "is there an X-Forwarded-For header?" — asks the caller whether to rate-limit
 * them: anyone could send that header on a direct connection and switch the
 * per-address limit off. So the signal is the operator's own configuration:
 * `PROTOCOL_HEADER` or `HOST_HEADER` is how a deployment tells `adapter-node`
 * there is a trusted proxy in front of it (the Dockerfile sets the first), and
 * `ADDRESS_HEADER` is how it says the client address can be recovered from that
 * proxy's headers.
 *
 * These are the adapter's variables, not ours, so they are read from the
 * environment directly rather than through `./env`. They are read on each call
 * rather than cached because tests set them per case; the cost is a property
 * lookup on a login attempt.
 *
 * Returns false only for a deployment that says it is proxied and has not said
 * which header carries the address. Callers should then fall back to the limits
 * that do not depend on the address — for login that is the per-username bucket,
 * which is the credential-stuffing control anyway.
 *
 * A proxy in front of a deployment that sets none of these three is not detected,
 * and the shared-bucket lockout is possible there. That is the deliberate
 * direction to be wrong in: the alternative reads the request, and then the
 * attacker is the one choosing whether they are rate-limited.
 */
export function addressIsDistinguishing(): boolean {
  if (process.env.ADDRESS_HEADER) return true;
  if (!process.env.PROTOCOL_HEADER && !process.env.HOST_HEADER) return true;

  if (!warnedAboutAddress) {
    warnedAboutAddress = true;
    console.warn(
      '[rate-limit] This deployment is configured as proxied (PROTOCOL_HEADER/HOST_HEADER) but ' +
        'ADDRESS_HEADER is not set, so every request appears to come from the proxy. Per-address ' +
        'limits are disabled to avoid locking out all users at once. Set ' +
        'ADDRESS_HEADER=X-Forwarded-For — and make sure the proxy overwrites it rather than ' +
        'appending to a client-supplied value.',
    );
  }
  return false;
}
