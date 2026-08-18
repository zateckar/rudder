/**
 * Helper to get a REST-only PodmanClient from a worker record.
 * SSH is used only for worker provisioning, not for container operations.
 */
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

export function getRestPodmanClient(
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
