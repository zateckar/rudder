/**
 * Helper to get a REST-only PodmanClient from a worker record.
 * SSH is used only for worker provisioning, not for container operations.
 */
import { createHash } from 'node:crypto';
import { createPodmanClient, PodmanApiError, type PodmanClient } from './podman';
import { decryptField } from './encryption';
import { env } from './env';
import type { workers } from '$lib/db/schema';
import { json } from '@sveltejs/kit';

/**
 * Turn a failed Podman call into the response the caller deserves.
 *
 * A refusal Podman is entitled to make — the image is still in use, the
 * container is already gone — is the client's problem and keeps its own 4xx.
 * Everything else is either Podman failing (502: Rudder reached it and it broke)
 * or Rudder failing before it got there (500).
 */
export function podmanErrorResponse(error: unknown, fallback = 'Podman request failed') {
  if (error instanceof PodmanApiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    return json({ error: error.detail }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message || fallback }, { status: 500 });
}

/**
 * Workers already warned about, so the notice does not repeat per request.
 *
 * A client is built for every terminal frame, exec and metrics poll, so warning
 * on each call buries the log it is meant to stand out in — and it is the same
 * sentence about the same worker every time.
 */
const warnedInsecure = new Set<string>();

function warnInsecureOnce(workerId: string, message: string): void {
  if (warnedInsecure.has(workerId)) return;
  warnedInsecure.add(workerId);
  console.warn(message);
}

/**
 * One live client per worker, so keep-alive can actually keep anything alive.
 *
 * Every client owns an `https.Agent` built with `keepAlive: true`, and every
 * caller built a fresh one and destroyed it when it was done — so the pool was
 * emptied before it could ever be drawn on. Every call to a worker paid a full
 * TLS handshake, plus parsing and decrypting the client key to construct the
 * agent, and that is the hottest path in the panel: a metrics cycle against
 * every worker, a stats call per container, every terminal frame, every log
 * poll, every page that inspects something.
 *
 * Keyed by worker id, and re-checked against a fingerprint of the credentials
 * so a rotation is picked up on the next call by whoever passes the new row —
 * a cache that kept serving a revoked certificate would be a security bug, not
 * a performance one. `evictPodmanClient` handles the case a fingerprint cannot:
 * a worker that is deleted, whose row nobody will ever pass again.
 *
 * Safe for the hijacked-connection paths because `/exec/{id}/start` sends
 * `Connection: close`, so a socket Podman is going to take over never re-enters
 * the pool for the next request to be dispatched onto. That was already true;
 * it is what makes sharing the agent across callers safe rather than a return
 * of the "aborted" race.
 */
const clients = new Map<string, { client: PodmanClient; fingerprint: string }>();

/**
 * What has to be identical for a cached client to still be the right one.
 *
 * The credentials as stored, not as decrypted — this only has to detect change,
 * and hashing the ciphertext keeps the plaintext key out of a long-lived map
 * key. The insecure flag is in here because it changes what the agent verifies.
 */
function credentialFingerprint(worker: typeof workers.$inferSelect): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        worker.podmanApiUrl,
        worker.podmanCaCert,
        worker.podmanClientCert,
        worker.podmanClientKey,
        env.ALLOW_INSECURE_PODMAN,
      ]),
    )
    .digest('hex');
}

/**
 * Drop a worker's cached client and close its sockets.
 *
 * Call when a worker is deleted. Rotation does not need it — the fingerprint
 * catches that — but a deleted worker's row is never passed again, so nothing
 * would ever notice its agent still holding connections open.
 */
export function evictPodmanClient(workerId: string): void {
  const entry = clients.get(workerId);
  if (!entry) return;
  clients.delete(workerId);
  entry.client.destroyAgents();
}

export function getRestPodmanClient(
  worker: typeof workers.$inferSelect
): PodmanClient {
  const cached = clients.get(worker.id);
  const fingerprint = credentialFingerprint(worker);
  if (cached) {
    if (cached.fingerprint === fingerprint) return cached.client;
    // Credentials changed under us. The old agent's sockets were authenticated
    // with the old certificate and must not be reused.
    evictPodmanClient(worker.id);
  }

  const client = buildRestPodmanClient(worker);
  client.markPooled();
  clients.set(worker.id, { client, fingerprint });
  return client;
}

function buildRestPodmanClient(
  worker: typeof workers.$inferSelect
): PodmanClient {
  if (!worker.podmanApiUrl) {
    throw new Error(`Worker "${worker.name}" has no Podman REST API URL configured`);
  }

  const hasMtls =
    worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey;

  if (hasMtls) {
    if (env.ALLOW_INSECURE_PODMAN) {
      warnInsecureOnce(
        `verify:${worker.id}`,
        `[podman] Not verifying the server certificate of worker "${worker.name}" because ` +
          `ALLOW_INSECURE_PODMAN is set. Anything on the network path can impersonate it.`,
      );
    }
    return createPodmanClient({
      apiUrl: worker.podmanApiUrl,
      caCert: worker.podmanCaCert!,
      clientCert: worker.podmanClientCert!,
      clientKey: decryptField(worker.podmanClientKey!),
      // Verification is on by default. The escape hatch is the same flag that
      // already governs talking to a worker with no mTLS at all, so an operator
      // bringing up a worker whose Traefik has not yet obtained a certificate
      // has one switch to reason about rather than two.
      insecureSkipVerify: env.ALLOW_INSECURE_PODMAN,
    });
  }

  // The Podman API is root-equivalent on the worker.  Falling back to plain
  // HTTP silently would turn a half-provisioned worker into an unauthenticated
  // remote-control endpoint, so this now fails closed unless an operator has
  // explicitly opted in (local/dev workers).
  if (env.ALLOW_INSECURE_PODMAN) {
    warnInsecureOnce(
      `plaintext:${worker.id}`,
      `[podman] Worker "${worker.name}" has no mTLS credentials — connecting over plain HTTP ` +
        `because ALLOW_INSECURE_PODMAN is set. Do not use this in production.`,
    );
    return createPodmanClient({ apiUrl: worker.podmanApiUrl });
  }

  throw new Error(
    `Worker "${worker.name}" has no mTLS credentials configured. Re-provision the worker, ` +
      `or set ALLOW_INSECURE_PODMAN=true to allow unauthenticated Podman API access.`,
  );
}

/**
 * Run `fn` against a worker's Podman API.
 *
 * This existed to guarantee the client was disposed of on every exit path, back
 * when each caller owned an agent and leaking one held TLS sockets open for the
 * life of the process. Route handlers were doing that by hand across 30 call
 * sites, each an opportunity to miss one, and at least one did:
 * `GET /api/containers/[id]` destroyed the client after a successful inspect
 * and not at all when the inspect threw — exactly the case where a worker is
 * misbehaving and the request is most likely to be retried.
 *
 * The agent is now pooled per worker, so there is nothing left to leak and
 * nothing to dispose of; `client.destroy()` on a pooled client is a no-op by
 * design. What this is still worth keeping for is that it is the shape that
 * cannot get the lifetime wrong, whatever the lifetime turns out to be — which
 * is why it stays the way a route should reach Podman.
 */
export async function withPodman<T>(
  worker: typeof workers.$inferSelect,
  fn: (client: PodmanClient) => Promise<T>,
): Promise<T> {
  return fn(getRestPodmanClient(worker));
}
