import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  const tailLines = parseInt(event.url.searchParams.get('tail') || '100');

  let crowdsecInspect: any = null;
  let crowdsecStatus = 'not_found';
  let crowdsecLogs = '';

  if (worker.podmanApiUrl) {
    await withPodman(worker, async (client) => {
      try {
        const allContainers = await client.listContainers(true);
        const csC = allContainers.find((c: any) =>
          c.Names?.includes('/crowdsec') || c.Names?.some((n: string) => n.includes('crowdsec')),
        );
        if (!csC) return;

        crowdsecStatus = csC.State || 'unknown';
        try { crowdsecInspect = await client.getContainer(csC.Id); } catch {}
        try {
          crowdsecLogs = await client.getContainerLogs(csC.Id, {
            stdout: true,
            stderr: true,
            tail: tailLines,
          });
        } catch {}
      } catch {
        // An unreachable worker leaves `not_found`, which is what the tab shows.
      }
    });
  }

  // Only the two fields the tab renders. The full `podman inspect` carries
  // Config.Env, which holds BOUNCER_KEY_traefik in plaintext — sending it to
  // the browser puts a live credential in DevTools and in any exported HAR.
  // The bouncer key itself is likewise never returned: whether one is
  // configured is all the page needs to say.
  //
  // `decisions` and `appsecStatus` were declared here, never assigned, run
  // through a JSON.parse that could only ever see an empty string, and returned
  // as `[]` and `''`. They came from an SSH path that no longer exists; the
  // CrowdSec LAPI listens on 127.0.0.1 and the control plane cannot reach it.
  // Reporting them as absent is the same answer with none of the theatre.
  return json({
    status: crowdsecStatus,
    image: crowdsecInspect?.Config?.Image ?? null,
    startedAt: crowdsecInspect?.State?.StartedAt ?? null,
    logs: crowdsecLogs,
    bouncerKeyConfigured: !!worker.crowdsecBouncerKey,
    decisions: [],
    appsecStatus: '',
  });
});
