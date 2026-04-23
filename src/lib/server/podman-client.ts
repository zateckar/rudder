/**
 * Helper to get a REST-only PodmanClient from a worker record.
 * SSH is used only for worker provisioning, not for container operations.
 */
import { createPodmanClient, type PodmanClient } from './podman';
import type { workers } from '$lib/db/schema';

export function getRestPodmanClient(
  worker: typeof workers.$inferSelect
): PodmanClient {
  if (
    worker.podmanApiUrl &&
    worker.podmanCaCert &&
    worker.podmanClientCert &&
    worker.podmanClientKey
  ) {
    return createPodmanClient({
      apiUrl: worker.podmanApiUrl,
      caCert: worker.podmanCaCert,
      clientCert: worker.podmanClientCert,
      clientKey: worker.podmanClientKey,
    });
  }

  if (worker.podmanApiUrl) {
    // HTTP (no mTLS) — for local/dev workers
    return createPodmanClient({ apiUrl: worker.podmanApiUrl });
  }

  throw new Error(`Worker "${worker.name}" has no Podman REST API URL configured`);
}
