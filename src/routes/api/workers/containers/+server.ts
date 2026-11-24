import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '#lib/server/podman-client.ts';
import { requireWorkerWithApi, route } from '#lib/server/auth.ts';

/**
 * GET /api/workers/containers?workerId=… — every container on one worker,
 * straight from its Podman API.
 *
 * The `getPodmanClient` wrapper that used to sit here returned
 * `{ client, useRestApi: true }`; nothing read `useRestApi`, and the only thing
 * it decided beyond that was whether `podmanApiUrl` was set, which
 * `requireWorkerWithApi` now says with a message naming the worker.
 */
export const GET: RequestHandler = route(async (event) => {
  const workerId = event.url.searchParams.get('workerId');
  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const { worker } = await requireWorkerWithApi(event, workerId);
  return json(await withPodman(worker, (c) => c.listContainers(true)));
});
