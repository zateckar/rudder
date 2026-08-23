import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';

/**
 * GET /api/containers/[id]/terminal — the last 500 log lines, as plain text.
 *
 * There is no separate "is a client available" check here any more. It used to
 * test the four mTLS columns by hand and answer 400 when any was missing;
 * `getRestPodmanClient` makes exactly that decision, with the
 * ALLOW_INSECURE_PODMAN escape hatch the hand-written copy did not know about,
 * and its refusal already names the worker and says to re-provision it.
 */
export const GET: RequestHandler = route(async (event) => {
  const { container, worker } = await requireContainer(event, event.params.id!);

  const logs = await withPodman(worker, (client) =>
    client.getContainerLogs(container.containerId, {
      stdout: true,
      stderr: true,
      tail: 500,
      timestamps: true,
    }),
  );

  return new Response(logs, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache',
    },
  });
});
