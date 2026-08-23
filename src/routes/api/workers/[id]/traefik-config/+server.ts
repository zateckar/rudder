import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { decryptField } from '$lib/server/encryption';
import { buildWorkerDynamicConfig } from '$lib/server/traefik-config';
import { createHash, timingSafeEqual } from 'crypto';

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

  // Recorded before the 304 branch, not after it.
  //
  // A deploy's cutover waits on `configFetchedAt` to know the worker has taken
  // the new routing — see `waitForConfigConvergence` — and only reaps the old
  // generation once it has. A 304 that skipped this write would stall every
  // cutover until something happened to change the document, which is the one
  // thing that must not depend on the response being a 200.
  await db
    .update(workers)
    .set({ configFetchedAt: new Date(), lastSeenAt: new Date() })
    .where(eq(workers.id, worker.id));

  // The document is rebuilt from the database on every request — this is not a
  // cache, and a stale route is never served. The ETag saves sending the body
  // again, which matters because it carries every hostname on the worker and is
  // fetched on a timer measured in seconds.
  //
  // It does *not* save the worker rewriting routes.yml or Traefik reloading it:
  // `rudder-traefik-config.sh` already compares the fetched document against
  // the installed one with `cmp` and stops there. That script is deliberately
  // left alone — with `curl -f`, a 304 writes an empty staging file, which its
  // "is this a routing document" check would reject, and a worker that stops
  // updating its routes is a far worse outcome than a redundant transfer. The
  // header is here for any client that does handle it, and because an endpoint
  // polled this often should answer conditional requests correctly.
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'no-store' },
    });
  }

  return text(body, { headers: { 'Content-Type': 'application/json', ETag: etag } });
};
