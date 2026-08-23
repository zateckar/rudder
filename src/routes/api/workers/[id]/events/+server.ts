import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  const { url } = event;

  const since = url.searchParams.get('since') || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const type = url.searchParams.get('type'); // container, image, pod, system, volume
  const container = url.searchParams.get('container');

  const filters: Record<string, string[]> = {};
  if (type) filters.type = [type];
  if (container) filters.container = [container];

  // A worker with no API URL reports no events rather than failing: this is a
  // diagnostic view, and an unprovisioned worker genuinely has none.
  const events = worker.podmanApiUrl
    ? await withPodman(worker, (c) =>
        c.events(since, undefined, Object.keys(filters).length > 0 ? filters : undefined),
      )
    : [];

  return json({ events, count: events.length });
});
