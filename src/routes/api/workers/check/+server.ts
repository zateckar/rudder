import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

/** POST /api/workers/check — ping one worker now and record what came back. */
export const POST: RequestHandler = route(async (event) => {
  const { workerId } = await event.request.json();
  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const { worker } = await requireWorker(event, workerId);

  let isOnline = false;
  if (worker.podmanApiUrl) {
    try {
      isOnline = await withPodman(worker, (c) => c.ping());
    } catch (e) {
      // A worker with no usable credentials, or one that is simply down. Both
      // are `offline` as far as this check is concerned.
      console.warn('[workers/check] Podman API check failed:', e);
    }
  }

  await db
    .update(workers)
    .set(isOnline ? { status: 'online', lastSeenAt: new Date() } : { status: 'offline' })
    .where(eq(workers.id, workerId));

  return json({ online: isOnline });
});
