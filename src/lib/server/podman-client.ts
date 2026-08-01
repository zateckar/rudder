/**
 * Helper to get a REST-only PodmanClient from a worker record.
 * SSH is used only for worker provisioning, not for container operations.
 */
import { createPodmanClient, type PodmanClient } from './podman';
import { decryptField } from './encryption';
import { env } from './env';
import type { workers } from '$lib/db/schema';

export function getRestPodmanClient(
  worker: typeof workers.$inferSelect
): PodmanClient {
  if (!worker.podmanApiUrl) {
    throw new Error(`Worker "${worker.name}" has no Podman REST API URL configured`);
  }

  const hasMtls =
    worker.podmanCaCert && worker.podmanClientCert && worker.podmanClientKey;

  if (hasMtls) {
    return createPodmanClient({
      apiUrl: worker.podmanApiUrl,
      caCert: worker.podmanCaCert!,
      clientCert: worker.podmanClientCert!,
      clientKey: decryptField(worker.podmanClientKey!),
    });
  }

  // The Podman API is root-equivalent on the worker.  Falling back to plain
  // HTTP silently would turn a half-provisioned worker into an unauthenticated
  // remote-control endpoint, so this now fails closed unless an operator has
  // explicitly opted in (local/dev workers).
  if (env.ALLOW_INSECURE_PODMAN) {
    console.warn(
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
