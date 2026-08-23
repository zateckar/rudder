import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';
import type { PodmanClient } from '$lib/server/podman';

/** Run a command in the Traefik container; empty string on any failure. */
async function restExec(client: PodmanClient, containerId: string, cmd: string[]): Promise<string> {
  try {
    const r = await client.execContainerHttp(containerId, cmd);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

export const GET: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);
  const tailLines = parseInt(event.url.searchParams.get('tail') || '100');

  let traefikInspect: any = null;
  let traefikStatus = 'not_found';
  let traefikLogs = '';
  let traefikStaticConfig = '';
  const traefikDynamicConfigs: Record<string, string> = {};

  // One client for both halves. This used to build a second one for the config
  // reads — a whole extra mTLS handshake to the same worker, in the same
  // request, because the two blocks were written at different times.
  if (worker.podmanApiUrl) {
    await withPodman(worker, async (client) => {
      let traefikId: string | null = null;
      try {
        const allContainers = await client.listContainers(true);
        const traefikC = allContainers.find((c: any) =>
          c.Names?.includes('/traefik') || c.Names?.some((n: string) => n.includes('traefik')),
        );
        if (traefikC) {
          traefikId = traefikC.Id;
          traefikStatus = traefikC.State || 'unknown';
          try { traefikInspect = await client.getContainer(traefikC.Id); } catch {}
          try {
            traefikLogs = await client.getContainerLogs(traefikC.Id, {
              stdout: true,
              stderr: true,
              tail: tailLines,
            });
          } catch {}
        }
      } catch {
        // Unreachable worker: `not_found` is what the tab shows.
      }

      if (!traefikId) return;

      traefikStaticConfig = await restExec(client, 'traefik', ['cat', '/etc/traefik/traefik.yml']);

      const dynamicList = await restExec(client, 'traefik', ['ls', '/etc/traefik/dynamic/']);
      for (const file of dynamicList.split('\n').filter(Boolean)) {
        const content = await restExec(client, 'traefik', ['cat', `/etc/traefik/dynamic/${file}`]);
        if (content) traefikDynamicConfigs[file] = content;
      }
    });
  }

  // Routing rules as Rudder recorded them, for comparison with what Traefik
  // actually loaded above.
  const dbContainers = await db
    .select({ name: containers.name, labels: containers.labels })
    .from(containers)
    .where(eq(containers.workerId, workerId))
    .all();

  const routes: Array<{ app: string; rule: string; entrypoint: string; service: string }> = [];
  for (const c of dbContainers) {
    if (!c.labels) continue;
    try {
      const labels: Record<string, string> = JSON.parse(c.labels);
      for (const [key, val] of Object.entries(labels)) {
        if (!key.includes('traefik.http.routers.') || !key.endsWith('.rule')) continue;
        const routerName = key.replace('traefik.http.routers.', '').replace('.rule', '');
        routes.push({
          app: c.name,
          rule: val,
          entrypoint: labels[`traefik.http.routers.${routerName}.entrypoints`] || '—',
          service: labels[`traefik.http.routers.${routerName}.service`] || '—',
        });
      }
    } catch {
      // Unparseable label blob — nothing to report for this container.
    }
  }

  // Narrowed for the same reason as the CrowdSec tab: Traefik's Config.Env
  // carries the CrowdSec bouncer key it was provisioned with.
  return json({
    status: traefikStatus,
    image: traefikInspect?.Config?.Image ?? null,
    startedAt: traefikInspect?.State?.StartedAt ?? null,
    logs: traefikLogs,
    staticConfig: traefikStaticConfig,
    dynamicConfigs: traefikDynamicConfigs,
    routes,
  });
});
