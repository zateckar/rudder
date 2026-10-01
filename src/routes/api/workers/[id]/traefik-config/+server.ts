import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateWorker } from '$lib/server/worker-token';
import { acknowledgeRoutingSnapshot, routingSnapshot } from '$lib/server/routing-convergence';

/** Fetch telemetry says only that a response was served, never that routes were installed. */
export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
  setHeaders({ 'Cache-Control': 'no-store' });
  const worker = await authenticateWorker(params.id, request);
  if (!worker) return json({ error: 'Unauthorized' }, { status: 401 });
  if (worker.routingMode !== 'http') return json({ error: 'Worker is in labels routing mode.' }, { status: 409 });
  try {
    const { body, hash } = await routingSnapshot(worker.id);
    db.update(workers).set({ configFetchedAt: new Date(), lastSeenAt: new Date() })
      .where(eq(workers.id, worker.id)).run();
    const headers = { ETag: `"${hash}"`, 'X-Rudder-Config-Hash': hash, 'Cache-Control': 'no-store' };
    if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
    return text(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[traefik-config] generation failed for worker', worker.id, e?.message);
    return json({ error: 'Configuration unavailable' }, { status: 503 });
  }
};

/** A worker acknowledges only after its local Traefik API reports the installed body. */
export const POST: RequestHandler = async ({ params, request, setHeaders }) => {
  setHeaders({ 'Cache-Control': 'no-store' });
  const worker = await authenticateWorker(params.id, request);
  if (!worker) return json({ error: 'Unauthorized' }, { status: 401 });
  if (worker.routingMode !== 'http') return json({ error: 'Worker is in labels routing mode.' }, { status: 409 });
  let hash: unknown;
  try { hash = (await request.json()).hash; } catch { return json({ error: 'Invalid acknowledgement' }, { status: 400 }); }
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return json({ error: 'Invalid content hash' }, { status: 400 });
  try {
    const snapshot = await routingSnapshot(worker.id);
    if (hash !== snapshot.hash || !acknowledgeRoutingSnapshot(worker.id, snapshot)) {
      return json({ error: 'Routing configuration changed; fetch and verify again' }, { status: 409 });
    }
    return json({ acknowledged: hash });
  } catch (e: any) {
    console.error('[traefik-config] acknowledgement failed for worker', worker.id, e?.message);
    return json({ error: 'Configuration unavailable' }, { status: 503 });
  }
};
