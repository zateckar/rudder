import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorkerWithApi, route } from '$lib/server/auth';

export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorkerWithApi(event, event.params.id!);
  const result = await withPodman(worker, (c) => c.systemPrune(true));
  return json({ success: true, result });
});
