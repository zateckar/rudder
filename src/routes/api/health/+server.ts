/**
 * Unauthenticated health-check endpoint.
 *
 * Returns 200 OK so that Docker, Kubernetes liveness/readiness probes, and
 * load-balancers can confirm the process is running without requiring a valid
 * session cookie.
 */
import { json } from '@sveltejs/kit';

export function GET() {
  return json({ status: 'ok' });
}
