import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { encryptField } from '$lib/server/encryption';
import {
  checkPublicUrlReachable,
  configEndpointUrl,
  generateConfigToken,
} from '$lib/server/worker-config-endpoint';
import { env } from '$lib/server/env';

/**
 * PUT /api/workers/[id]/routing-mode — switch a worker between reading its
 * routing from container labels and fetching it from the control plane.
 *
 * Flipping the flag alone does not move anything: the worker has to be
 * re-provisioned to install (or remove) the fetch timer, and its applications
 * redeployed to gain or drop their `traefik.*` labels. The response says so
 * explicitly rather than leaving the operator to discover it.
 */
export const PUT: RequestHandler = async ({ params, request, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const mode = body?.routingMode;
  if (mode !== 'labels' && mode !== 'http') {
    return json({ error: 'routingMode must be "labels" or "http"' }, { status: 400 });
  }

  if (mode === worker.routingMode) {
    return json({ routingMode: mode, message: `Worker is already in ${mode} routing mode.` });
  }

  const appCount = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.workerId, worker.id))
    .all();

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
        `its ${appCount.length} application(s) so their container labels are dropped. Until both are done the ` +
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
      `routes file, then redeploy its ${appCount.length} application(s) to restore their labels. Doing it in ` +
      `that order avoids a window with no routes at all.`,
  });
};
