import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { decryptField } from '$lib/server/encryption';
import { buildWorkerDynamicConfig } from '$lib/server/traefik-config';
import { timingSafeEqual } from 'crypto';

/**
 * GET /api/workers/[id]/traefik-config
 *
 * Machine-to-machine: the worker's `rudder-traefik-config` timer fetches this
 * and writes it to /etc/traefik/dynamic/routes.yml. No session, no CSRF — the
 * credential is the per-worker bearer token issued at provisioning time.
 *
 * Deliberately excluded from the audit log: this is polled every few seconds
 * and would drown the trail.
 */

/** Constant-time compare that does not leak length through an early return. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the failure takes the same shape.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
  setHeaders({ 'Cache-Control': 'no-store' });

  const auth = request.headers.get('authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!presented) return json({ error: 'Unauthorized' }, { status: 401 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  // Same response whether the worker is absent, has no token, or the token is
  // wrong — the endpoint must not be usable to enumerate worker ids.
  if (!worker?.configToken) return json({ error: 'Unauthorized' }, { status: 401 });

  const expected = decryptField(worker.configToken);
  if (!expected || !tokensMatch(presented, expected)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (worker.routingMode !== 'http') {
    // Serving routes to a labels-mode worker would give Traefik two providers
    // defining the same router name, with arbitrary resolution between them.
    return json(
      { error: 'Worker is in labels routing mode; routing configuration is served through container labels.' },
      { status: 409 },
    );
  }

  let body: string;
  try {
    const config = await buildWorkerDynamicConfig(worker.id);
    body = JSON.stringify(config);
  } catch (e: any) {
    // A partial document would be installed over a complete one. Fail the
    // fetch instead and let the worker keep the file it already has.
    console.error('[traefik-config] generation failed for worker', worker.id, e?.message);
    return json({ error: 'Configuration unavailable' }, { status: 503 });
  }

  await db
    .update(workers)
    .set({ configFetchedAt: new Date(), lastSeenAt: new Date() })
    .where(eq(workers.id, worker.id));

  return text(body, { headers: { 'Content-Type': 'application/json' } });
};
