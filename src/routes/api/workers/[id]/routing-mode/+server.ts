import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { eq, count } from 'drizzle-orm';
import { encryptField } from '$lib/server/encryption';
import {
  checkPublicUrlReachable,
  configEndpointUrl,
  generateConfigToken,
} from '$lib/server/worker-config-endpoint';
import { env } from '$lib/server/env';
import { requireWorker, route } from '$lib/server/auth';

/**
 * PUT /api/workers/[id]/routing-mode — switch a worker between reading its
 * routing from container labels and fetching it from the control plane.
 *
 * Flipping the flag alone does not move anything: the worker has to be
 * re-provisioned to install (or remove) the fetch timer, and its applications
 * redeployed to gain or drop their `traefik.*` labels. The response says so
 * explicitly rather than leaving the operator to discover it.
 */
export const PUT: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const body = await event.request.json().catch(() => ({}));
  const mode = body?.routingMode;
  if (mode !== 'labels' && mode !== 'http') {
    return json({ error: 'routingMode must be "labels" or "http"' }, { status: 400 });
  }

  if (mode === worker.routingMode) {
    return json({ routingMode: mode, message: `Worker is already in ${mode} routing mode.` });
  }

  // A count, not the rows: this selected every application on the worker to
  // interpolate `.length` into one sentence.
  const appCount =
    (await db
      .select({ n: count() })
      .from(applications)
      .where(eq(applications.workerId, worker.id))
      .get())?.n ?? 0;

  if (mode === 'http') {
    const unreachable = checkPublicUrlReachable();
    if (unreachable) return json({ error: unreachable }, { status: 400 });

    const token = generateConfigToken();
    await db
      .update(workers)
      .set({ routingMode: 'http', configToken: encryptField(token), configFetchedAt: null })
      .where(eq(workers.id, worker.id));

    return json({
      routingMode: 'http',
      endpoint: configEndpointUrl(worker.id, env.PUBLIC_URL),
      message:
        `Switched to control-plane routing. Re-provision the worker to install the fetch timer, then redeploy ` +
        `its ${appCount} application(s) so their container labels are dropped. Until both are done the ` +
        `worker keeps serving from its existing labels.`,
    });
  }

  await db
    .update(workers)
    .set({ routingMode: 'labels', configFetchedAt: null })
    .where(eq(workers.id, worker.id));

  return json({
    routingMode: 'labels',
    message:
      `Switched back to container labels. Re-provision the worker to remove the fetch timer and the served ` +
      `routes file, then redeploy its ${appCount} application(s) to restore their labels. Doing it in ` +
      `that order avoids a window with no routes at all.`,
  });
});
