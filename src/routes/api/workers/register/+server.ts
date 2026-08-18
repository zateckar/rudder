import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { timingSafeEqual, createHash } from 'crypto';
import { decryptField, encryptField } from '$lib/server/encryption';

/** Compare two secrets without leaking length or content through timing. */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Two credentials, because they answer two different questions.
 *
 * `WORKER_REGISTRATION_SECRET` says self-registration is switched on at all. It
 * is shared by every worker, so on its own it only established that the caller
 * was *some* worker — and this endpoint picks its target by the hostname in the
 * request body, so any holder could rotate the stored CA and client certificate
 * of any *other* worker, pointing Rudder's trust at material of their choosing.
 *
 * The per-worker `configToken` — issued at provisioning time, and also the
 * credential for `/api/workers/[id]/traefik-config` — is what says which worker
 * is calling. The worker reads it from `/etc/rudder/worker.env`, which
 * provisioning writes in both routing modes for exactly this reason.
 *
 * A worker with no token cannot self-register. Re-provision it: that mints one.
 */
export async function POST({ request }: { request: Request }) {
  // Require a shared secret for worker self-registration
  const registrationSecret = env.WORKER_REGISTRATION_SECRET;
  if (!registrationSecret) {
    return json({ error: 'Worker registration is not configured' }, { status: 503 });
  }

  // The request body is a one-shot stream: the previous implementation read it
  // twice, so supplying the token in the body always failed with a 400.
  let body: any = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : typeof body.token === 'string'
      ? body.token
      : null;

  if (!token || !secretsMatch(token, registrationSecret)) {
    return json({ error: 'Unauthorized - invalid registration token' }, { status: 401 });
  }

  const { hostname, caCert, clientCert, clientKey } = body;

  if (!hostname || typeof hostname !== 'string') {
    return json({ error: 'Hostname required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.hostname, hostname)).get();

  if (!worker) {
    return json({ error: 'Worker not found - must be provisioned first' }, { status: 404 });
  }

  // Prove the caller is *this* worker, not merely a holder of the shared secret.
  const workerToken = typeof body.workerToken === 'string' ? body.workerToken : null;
  const expectedToken = worker.configToken ? decryptField(worker.configToken) : null;
  if (!workerToken || !expectedToken || !secretsMatch(workerToken, expectedToken)) {
    // One message for every failure: absent token, absent worker token, wrong
    // token. Distinguishing them would let a caller probe which hostnames are
    // registered and which are re-provisionable.
    return json({ error: 'Unauthorized - invalid worker token' }, { status: 401 });
  }

  // Registration rotates the credentials Rudder uses to reach this worker, so
  // only accept a complete, self-consistent set. A partial update could strip
  // mTLS material and leave the worker unreachable (or, previously, silently
  // downgraded to plain HTTP).
  if (!caCert || !clientCert || !clientKey) {
    return json(
      { error: 'caCert, clientCert and clientKey are all required' },
      { status: 400 },
    );
  }

  await db.update(workers)
    .set({
      podmanApiUrl: `https://${hostname}:8443`,
      podmanCaCert: caCert,
      podmanClientCert: clientCert,
      podmanClientKey: encryptField(clientKey),
    })
    .where(eq(workers.id, worker.id));

  console.log(`[register] Rotated Podman credentials for worker "${worker.name}" (${hostname})`);

  return json({ success: true, message: 'Worker registered successfully' });
}
