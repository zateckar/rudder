/**
 * Authenticating a worker fetching its own configuration.
 *
 * Machine-to-machine: no session, no CSRF. The credential is the per-worker
 * token issued at provisioning time. Shared by every config endpoint a worker
 * polls, so there is one implementation of the comparison rather than one per
 * endpoint drifting apart.
 */
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { decryptField } from '$lib/server/encryption';
import { timingSafeEqual } from 'crypto';

/** Constant-time compare that does not leak length through an early return. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the failure takes the same shape.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * The worker's credential, from whichever header it could use.
 *
 * `Authorization: Bearer` is the normal case. But a control plane published
 * behind a proxy that demands HTTP Basic leaves that header spoken for — the
 * outer layer has to be satisfied first or the request never arrives — so the
 * worker moves its own token to `X-Rudder-Config-Token` and sends Basic in
 * `Authorization`. Both are accepted: workers provisioned before this only know
 * the Bearer form, and a control plane is upgraded before its workers are.
 */
export function presentedToken(request: Request): string {
  const header = request.headers.get('x-rudder-config-token');
  if (header?.trim()) return header.trim();

  const auth = request.headers.get('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * The worker this request is authenticated as, or null.
 *
 * Null covers every failure — absent worker, no token issued, wrong token —
 * because the caller must answer all three identically or the endpoint becomes
 * a way to enumerate worker ids.
 */
export async function authenticateWorker(
  workerId: string,
  request: Request,
): Promise<typeof workers.$inferSelect | null> {
  const presented = presentedToken(request);
  if (!presented) return null;

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker?.configToken) return null;

  const expected = decryptField(worker.configToken);
  if (!expected || !tokensMatch(presented, expected)) return null;

  return worker;
}
