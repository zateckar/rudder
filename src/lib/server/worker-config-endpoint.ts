/**
 * Where a worker fetches its routing configuration, and the credential it
 * presents.
 *
 * Split out from the provisioning route so the same rules apply wherever a
 * worker is (re-)provisioned or switched between routing modes.
 */
import { randomBytes } from 'crypto';
import { env } from './env';

/** Bearer token for the config endpoint. 32 bytes of entropy, hex-encoded. */
export function generateConfigToken(): string {
  return randomBytes(32).toString('hex');
}

export function configEndpointUrl(workerId: string, publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/workers/${workerId}/traefik-config`;
}

/**
 * Where a worker fetches its CrowdSec AppSec rule exclusions.
 *
 * Planted in both routing modes, unlike the routing endpoint: which rules an
 * application is exempt from has nothing to do with whether Traefik learns its
 * routes from labels or from a file.
 */
export function appsecEndpointUrl(workerId: string, publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/workers/${workerId}/appsec-config`;
}

/**
 * Reject a `PUBLIC_URL` a worker cannot actually reach.
 *
 * A worker whose endpoint resolves to its own loopback address fetches nothing
 * and serves no routes — and does so quietly, because a failed fetch is
 * indistinguishable from a control-plane blip. Better to refuse the cutover.
 *
 * Returns an error message, or null when the URL is usable.
 */
export function checkPublicUrlReachable(publicUrl: string = env.PUBLIC_URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return `PUBLIC_URL is not a valid URL ("${publicUrl}"). Workers in http routing mode fetch their configuration from it.`;
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    host.endsWith('.localhost');

  if (isLoopback) {
    return (
      `PUBLIC_URL points at ${parsed.hostname}, which a worker cannot reach. ` +
      `Set it to the address workers use to reach this control plane before switching a worker to http routing mode.`
    );
  }

  if (parsed.protocol !== 'https:') {
    return (
      `PUBLIC_URL uses ${parsed.protocol.replace(':', '')}. The routing configuration carries a bearer token and ` +
      `every hostname on the worker, so the endpoint must be https.`
    );
  }

  return null;
}
