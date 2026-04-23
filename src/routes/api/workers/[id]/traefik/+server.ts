import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { getSSHKey } from '$lib/server/ssh';
import { createSSHPodmanClient } from '$lib/server/podman';

async function sshExec(sshClient: any, cmd: string): Promise<string> {
  try {
    const r = await sshClient['exec'](cmd);
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

    // Fallback: use SSH to find traefik and read configs/logs
    if (worker.sshKeyId) {
      const sshKey = await getSSHKey(worker.sshKeyId);
      if (sshKey) {
        const sshClient = createSSHPodmanClient({
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        });

        // Find traefik container status
        const psOut = await sshExec(sshClient, `podman ps -a --filter name=traefik --format '{{.ID}} {{.Status}} {{.State}}' 2>/dev/null`);
        if (psOut && traefikStatus === 'not_found') {
          const parts = psOut.split(/\s+/);
          traefikStatus = parts[2] || parts[1] || 'unknown';
        }

        // Get logs
        if (!traefikLogs) {
          traefikLogs = await sshExec(sshClient, `podman logs --tail ${tailLines} traefik 2>&1`);
        }

        // Read static config
        traefikStaticConfig = await sshExec(sshClient, `cat /etc/traefik/traefik.yml 2>/dev/null || podman exec traefik cat /etc/traefik/traefik.yml 2>/dev/null`);

        // Read dynamic configs
        const dynamicList = await sshExec(sshClient, `ls /etc/traefik/dynamic/ 2>/dev/null`);
        if (dynamicList) {
          for (const file of dynamicList.split('\n').filter(Boolean)) {
            const content = await sshExec(sshClient, `cat "/etc/traefik/dynamic/${file}" 2>/dev/null`);
            if (content) {
              traefikDynamicConfigs[file] = content;
            }
          }
        }

        sshClient.destroy();
      }
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

    return json({
      status: traefikStatus,
      inspect: traefikInspect,
      logs: traefikLogs,
      staticConfig: traefikStaticConfig,
      dynamicConfigs: traefikDynamicConfigs,
      routes,
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
