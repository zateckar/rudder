import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
async function restExec(client: any, containerId: string, cmd: string[]): Promise<string> {
  try {
    const r = await client.execContainerHttp(containerId, cmd);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch { return ''; }
}

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const tailLines = parseInt(url.searchParams.get('tail') || '100');

  try {
    let traefikInspect: any = null;
    let traefikStatus = 'not_found';
    let traefikLogs = '';
    let traefikStaticConfig = '';
    let traefikDynamicConfigs: Record<string, string> = {};

    // Try to find traefik container via REST API
    if (worker.podmanApiUrl) {
      const client = getRestPodmanClient(worker);
      try {
        // List all containers to find traefik
        const allContainers = await client.listContainers(true);
        const traefikC = allContainers.find((c: any) =>
          c.Names?.includes('/traefik') || c.Names?.some((n: string) => n.includes('traefik'))
        );

        if (traefikC) {
          traefikStatus = traefikC.State || 'unknown';
          try {
            traefikInspect = await client.getContainer(traefikC.Id);
          } catch {}

          try {
            traefikLogs = await client.getContainerLogs(traefikC.Id, { stdout: true, stderr: true, tail: tailLines });
          } catch {}
        }
      } catch {}
      client.destroy();
    }

    // Read traefik configs via REST API exec (no SSH needed)
    if (worker.podmanApiUrl && traefikStatus !== 'not_found') {
      const client = getRestPodmanClient(worker);
      try {
        // Read static config
        if (!traefikStaticConfig) {
          traefikStaticConfig = await restExec(client, 'traefik', ['cat', '/etc/traefik/traefik.yml']);
        }

        // Read dynamic configs
        const dynamicList = await restExec(client, 'traefik', ['ls', '/etc/traefik/dynamic/']);
        if (dynamicList) {
          for (const file of dynamicList.split('\n').filter(Boolean)) {
            if (!traefikDynamicConfigs[file]) {
              const content = await restExec(client, 'traefik', ['cat', `/etc/traefik/dynamic/${file}`]);
              if (content) {
                traefikDynamicConfigs[file] = content;
              }
            }
          }
        }
      } catch {}
      client.destroy();
    }

    // Get app routing rules from our DB containers
    const dbContainers = await db.select()
      .from(containers)
      .where(eq(containers.workerId, params.id))
      .all();

    const routes: Array<{ app: string; rule: string; entrypoint: string; service: string }> = [];
    for (const c of dbContainers) {
      if (!c.labels) continue;
      try {
        const labels: Record<string, string> = JSON.parse(c.labels);
        // Extract router rules
        for (const [key, val] of Object.entries(labels)) {
          if (key.includes('traefik.http.routers.') && key.endsWith('.rule')) {
            const routerName = key.replace('traefik.http.routers.', '').replace('.rule', '');
            const entryKey = `traefik.http.routers.${routerName}.entrypoints`;
            const serviceKey = `traefik.http.routers.${routerName}.service`;
            routes.push({
              app: c.name,
              rule: val,
              entrypoint: labels[entryKey] || '—',
              service: labels[serviceKey] || '—',
            });
          }
        }
      } catch {}
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
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
