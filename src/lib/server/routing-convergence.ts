import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { buildWorkerDynamicConfig } from './traefik-config';
import { CONVERGENCE_POLL_MS, CUTOVER_CONVERGENCE_TIMEOUT_MS } from './generations';

export function routingHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** A content snapshot is only valid if no cutover committed while it was built. */
export async function routingSnapshot(workerId: string): Promise<{ body: string; hash: string; revision: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = db.select({ revision: workers.routingRevision }).from(workers)
      .where(eq(workers.id, workerId)).get();
    if (!before) throw new Error(`Worker ${workerId} not found`);
    const body = JSON.stringify(await buildWorkerDynamicConfig(workerId));
    const after = db.select({ revision: workers.routingRevision }).from(workers)
      .where(eq(workers.id, workerId)).get();
    if (after?.revision === before.revision) return { body, hash: routingHash(body), revision: before.revision };
  }
  throw new Error('Routing configuration changed while being assembled');
}

export async function expectedRoutingHash(workerId: string): Promise<string> {
  return (await routingSnapshot(workerId)).hash;
}

/** No await between the final revision check and the write: cutover cannot interleave. */
export function acknowledgeRoutingSnapshot(workerId: string, snapshot: { hash: string; revision: number }): boolean {
  const result = db.update(workers).set({ configAppliedHash: snapshot.hash, lastSeenAt: new Date() })
    .where(and(eq(workers.id, workerId), eq(workers.routingRevision, snapshot.revision)))
    .returning({ id: workers.id }).get();
  return result !== undefined;
}

/** Installation acknowledgement comes from the worker after Traefik verifies the content. */
export async function waitForRoutingAcknowledgement(
  workerId: string,
  hash: string,
  timeoutMs = CUTOVER_CONVERGENCE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const row = db.select({ hash: workers.configAppliedHash }).from(workers)
      .where(eq(workers.id, workerId)).get();
    if (row?.hash === hash) return true;
    if (!row || Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(CONVERGENCE_POLL_MS, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}
